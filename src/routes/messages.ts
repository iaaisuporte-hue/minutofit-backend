import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import {
  ensureChatConversation,
  listChatConversations,
  listMessagesForConversation,
  markConversationRead,
  sendMessageToConversation,
} from '../services/messagesService';

const router = Router();

router.get(
  '/conversations',
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const data = await listChatConversations(req.user!.id, req.user!.role);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to list chat conversations' });
    }
  }
);

router.post(
  '/conversations',
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const studentId =
        body.studentId === undefined || body.studentId === null ? null : Number(body.studentId);
      const personalId =
        body.personalId === undefined || body.personalId === null ? null : Number(body.personalId);

      const data = await ensureChatConversation(req.user!.id, req.user!.role, {
        studentId: Number.isFinite(studentId) ? studentId : null,
        personalId: Number.isFinite(personalId) ? personalId : null,
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
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.conversationId);
      if (!Number.isFinite(conversationId)) {
        return res.status(400).json({ success: false, error: 'Invalid conversation id' });
      }

      const limitRaw = Number(req.query.limit);
      const data = await listMessagesForConversation(
        req.user!.id,
        req.user!.role,
        conversationId,
        Number.isFinite(limitRaw) ? limitRaw : 200
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
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.conversationId);
      if (!Number.isFinite(conversationId)) {
        return res.status(400).json({ success: false, error: 'Invalid conversation id' });
      }

      const data = await sendMessageToConversation(
        req.user!.id,
        req.user!.role,
        conversationId,
        typeof req.body?.text === 'string' ? req.body.text : ''
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

router.post(
  '/conversations/:conversationId/read',
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.conversationId);
      if (!Number.isFinite(conversationId)) {
        return res.status(400).json({ success: false, error: 'Invalid conversation id' });
      }

      await markConversationRead(req.user!.id, req.user!.role, conversationId);
      res.json({ success: true });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to mark chat as read' });
    }
  }
);

export default router;
