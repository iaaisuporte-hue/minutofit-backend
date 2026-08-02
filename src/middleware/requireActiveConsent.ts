import { type Request, type Response, type NextFunction } from 'express';
import { hasActiveConsent, type ConsentScope, type ProfessionalRole } from '../services/consentService';
import logger from '../lib/logger';
import { parseId } from '../utils/parseId';

/**
 * Garante que o profissional autenticado tem consentimento ativo do aluno
 * para o escopo solicitado antes de retornar dados sensíveis.
 *
 * Uso: router.get('/aluno/:studentId/dados', requireActiveConsent('workouts'), handler)
 *
 * O middleware busca o id do titular em req.params.studentId, patientId ou id.
 * Requer que o profissional esteja em req.user (authMiddleware já aplicado).
 *
 * Recomenda-se também aplicar este middleware no nível de prefixo de rota
 * (`router.use('/students/:studentId', requireActiveConsent('profile'))`) para
 * garantir defesa em profundidade — handlers individuais podem adicionar
 * escopos mais específicos (workouts, body_metrics, nutrition, ...).
 */
export function requireActiveConsent(scope: ConsentScope) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const professional = req.user;
    if (!professional) return res.status(401).end();

    const role: ProfessionalRole | undefined =
      professional.role === 'personal' || professional.role === 'nutri'
        ? (professional.role as ProfessionalRole)
        : undefined;

    if (!role) return next(); // admin ou outro role: não restrito por consent

    const rawStudentId = req.params.studentId ?? req.params.patientId ?? req.params.id;
    if (!rawStudentId) {
      // Fail-closed: profissional pedindo dado sensível sem que o middleware
      // consiga resolver o titular (param com outro nome, rota mal montada) é
      // sinal de gate incompleto — NUNCA liberar às cegas. Ver P0-3 da auditoria.
      logger.error(
        { path: req.originalUrl, scope, role, actorId: professional.id },
        '[consent] titular não resolvido em rota protegida — bloqueando (fail-closed)',
      );
      return res.status(403).json({ error: 'consent_subject_unresolved', scope });
    }

    // Faixa do int4 validada ANTES do banco: id fora dela estourava no Postgres
    // e, sem o try/catch abaixo, derrubava o processo (QA 02/ago/2026, P0-1).
    const studentId = parseId(rawStudentId);
    if (studentId === null) return res.status(400).json({ error: 'invalid_student_id' });

    try {
      const allowed = await hasActiveConsent(studentId, professional.id, role, scope);
      if (!allowed) {
        return res.status(403).json({ error: 'consent_required', scope });
      }
      return next();
    } catch (err) {
      // Middleware async NÃO tem captura automática no Express 4: sem este
      // catch a rejeição vira `unhandledRejection` e mata o processo. Entrega
      // ao error handler global, que responde 500 e reporta ao Sentry.
      return next(err);
    }
  };
}
