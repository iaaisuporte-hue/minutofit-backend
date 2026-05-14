import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireAcademyContext } from '../middleware/tenantContext';
import {
  ensureChatConversation,
  listChatConversations,
  listEligibleStudentsForPersonal,
  listMessagesForConversation,
  markConversationRead,
  sendMessageToConversation,
} from '../services/messagesService';
import { chatStreamSubscribe } from '../services/chatStream';

const router = Router();
router.use(authMiddleware, requireAcademyContext);

router.get(
  '/conversations',
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await listChatConversations(req.user!.id, req.user!.role, academyId);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to list chat conversations' });
    }
  }
);

router.post(
  '/conversations',
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const studentId =
        body.studentId === undefined || body.studentId === null ? null : Number(body.studentId);
      const personalId =
        body.personalId === undefined || body.personalId === null ? null : Number(body.personalId);

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await ensureChatConversation(req.user!.id, req.user!.role, {
        studentId: Number.isFinite(studentId) ? studentId : null,
        personalId: Number.isFinite(personalId) ? personalId : null,
        academyId,
      });

      res.status(201).json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'VALIDATION') {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (error?.code === 'ASSIGNMENT_REQUIRED' || error?.code === 'FORBIDDEN') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to ensure chat conversation' });
    }
  }
);

router.get(
  '/conversations/:conversationId/messages',
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.conversationId);
      if (!Number.isFinite(conversationId)) {
        return res.status(400).json({ success: false, error: 'Invalid conversation id' });
      }

      const limitRaw = Number(req.query.limit);
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await listMessagesForConversation(
        req.user!.id,
        req.user!.role,
        conversationId,
        Number.isFinite(limitRaw) ? limitRaw : 200,
        academyId
      );

      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to list chat messages' });
    }
  }
);

router.post(
  '/conversations/:conversationId/messages',
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.conversationId);
      if (!Number.isFinite(conversationId)) {
        return res.status(400).json({ success: false, error: 'Invalid conversation id' });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await sendMessageToConversation(
        req.user!.id,
        req.user!.role,
        conversationId,
        typeof req.body?.text === 'string' ? req.body.text : '',
        academyId
      );

      res.status(201).json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'VALIDATION') {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (error?.code === 'FORBIDDEN') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to send chat message' });
    }
  }
);

router.get(
  '/eligible-students',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const data = await listEligibleStudentsForPersonal(req.user!.id);
      res.json({ success: true, data });
    } catch (error: any) {
      res
        .status(500)
        .json({ success: false, error: error.message || 'Failed to list eligible students' });
    }
  }
);

router.post(
  '/conversations/:conversationId/read',
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.conversationId);
      if (!Number.isFinite(conversationId)) {
        return res.status(400).json({ success: false, error: 'Invalid conversation id' });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      await markConversationRead(req.user!.id, req.user!.role, conversationId, academyId);
      res.json({ success: true });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to mark chat as read' });
    }
  }
);

// GET /messages/conversations/:conversationId/stream — SSE para mensagens em tempo real
// O cliente abre esta conexão e recebe eventos quando novas mensagens são enviadas.
// Heartbeat a cada 25 segundos para manter a conexão viva através de proxies.
router.get(
  '/conversations/:conversationId/stream',
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    const conversationId = Number(req.params.conversationId);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid conversation id' });
    }

    // Verificar acesso à conversa antes de abrir o stream
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    try {
      await listMessagesForConversation(req.user!.id, req.user!.role, conversationId, 1, academyId);
    } catch (err: any) {
      const status = err?.code === 'NOT_FOUND' ? 404 : 403;
      return res.status(status).json({ success: false, error: err?.message ?? 'Acesso negado.' });
    }

    // Headers SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx: desabilita buffering
    res.flushHeaders();

    // Evento de confirmação de conexão
    res.write(`event: connected\ndata: ${JSON.stringify({ conversationId })}\n\n`);

    // Heartbeat para evitar timeout de proxy (25s)
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25_000);

    // Subscrever a mensagens desta conversa
    const unsubscribe = chatStreamSubscribe(conversationId, (payload) => {
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    // Limpeza ao fechar a conexão
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
);

export default router;
