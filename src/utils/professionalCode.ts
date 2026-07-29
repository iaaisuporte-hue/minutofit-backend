import pool from '../config/database';

/**
 * Gera o `users.professional_code` de um profissional recém-criado.
 *
 * Motivo: a coluna só havia sido populada pelo backfill da migration
 * `1790600000000_equipe-metacore-onda1.js`. Profissionais criados depois
 * (admin ou auto-cadastro) ficavam com código NULL, e o caminho "tenho o código
 * do meu profissional" do aluno (`resolveProfessionalByIdentifier`) nunca
 * resolvia para eles — só o e-mail funcionava.
 *
 * Mantém EXATAMENTE o mesmo formato do backfill para não criar dois padrões:
 * 4 letras maiúsculas do nome + id em hex com padding de 4 (ex.: `PERS0002`).
 * Como o hex deriva do `id`, o código é único por construção — o UNIQUE da
 * coluna nunca colide.
 *
 * Idempotente: só grava quando o código ainda é NULL. Nunca lança — falhar aqui
 * não pode derrubar a criação do profissional (o e-mail segue como identificador).
 */
export async function ensureProfessionalCode(userId: number): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET professional_code = UPPER(
                REGEXP_REPLACE(
                  SUBSTRING(REGEXP_REPLACE(COALESCE(name,'PRO'),'[^a-zA-Z]','','g') FROM 1 FOR 4),
                  '$', LPAD(TO_HEX(id), 4, '0')
                )
              ),
              updated_at = NOW()
        WHERE id = $1
          AND role IN ('personal','nutri')
          AND professional_code IS NULL
        RETURNING professional_code`,
      [userId]
    );
    return rows[0]?.professional_code ?? null;
  } catch (error) {
    console.error('[professionalCode] falha ao gerar código para user', userId, error);
    return null;
  }
}
