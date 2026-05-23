import { type Request, type Response, type NextFunction } from 'express';
import { hasActiveConsent, type ConsentScope, type ProfessionalRole } from '../services/consentService';

/**
 * Garante que o profissional autenticado tem consentimento ativo do aluno
 * para o escopo solicitado antes de retornar dados sensíveis.
 *
 * Uso: router.get('/aluno/:studentId/dados', requireActiveConsent('workouts'), handler)
 *
 * O middleware busca o `studentId` em req.params.studentId ou req.params.id.
 * Requer que o profissional esteja em req.user (authMiddleware já aplicado).
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

    const rawStudentId = req.params.studentId ?? req.params.id;
    if (!rawStudentId) return next(); // rota não tem parâmetro de aluno: ignorar

    const studentId = parseInt(rawStudentId, 10);
    if (isNaN(studentId)) return res.status(400).json({ error: 'invalid_student_id' });

    const allowed = await hasActiveConsent(studentId, professional.id, role, scope);
    if (!allowed) {
      return res.status(403).json({ error: 'consent_required', scope });
    }
    next();
  };
}
