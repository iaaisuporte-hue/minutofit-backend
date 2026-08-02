/**
 * Backfill do `source` de bônus em memberships de profissional
 * (QA 01/ago/2026, P1-4).
 *
 * Os call sites de `grantMembership` passavam a origem dentro de `metadata`
 * (`metadata.source = 'direct_invite'`) em vez do parâmetro `source`, então as
 * linhas caíam no default 'corefit'. Como `enterGraceForAppBonus` casa por
 * `source = 'bonus_personal' | 'bonus_nutri' | 'bonus_academy'`, o App bônus
 * nunca entrava em grace_period quando o vínculo terminava — e sem a janela de
 * graça não existe `convertGraceToStandalone`, ou seja, a ponte de conversão
 * B2C na borda do churn simplesmente não acontecia.
 *
 * O código já grava o `source` correto a partir de agora; isto corrige o
 * histórico. Critério conservador: só linhas que ainda estão em 'corefit' E que
 * comprovadamente vieram de um vínculo com profissional (professional_id
 * presente, ou marca de origem no metadata). Nada de reclassificar compra
 * direta, trial ou graça já em curso.
 */

/** Origens gravadas em metadata pelos call sites antigos, por produto pai. */
const APP_ORIGINS = {
  bonus_personal: ['direct_invite_personal', 'personal_direct_add'],
  bonus_nutri: ['direct_invite_nutri'],
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // 1. Produtos pai: personal / nutri / academia com profissional vinculado.
  for (const [productKey, bonusSource] of [
    ['personal', 'bonus_personal'],
    ['nutri', 'bonus_nutri'],
  ]) {
    await pgm.db.query(
      `UPDATE user_product_memberships
          SET source = $2
        WHERE product_key = $1
          AND source      = 'corefit'
          AND professional_id IS NOT NULL`,
      [productKey, bonusSource]
    );
  }

  // 2. App concedido junto do vínculo. Sem professional_id em parte dos call
  //    sites antigos, a marca confiável é a origem no metadata.
  for (const [bonusSource, origins] of Object.entries(APP_ORIGINS)) {
    await pgm.db.query(
      `UPDATE user_product_memberships
          SET source = $1
        WHERE product_key = 'app'
          AND source      = 'corefit'
          AND metadata->>'source' = ANY($2::text[])`,
      [bonusSource, origins]
    );
  }

  // 3. `connection_request_accept` grava professional_id no App e serve os dois
  //    papéis — o pai ativo do mesmo usuário decide qual bônus é.
  await pgm.db.query(`
    UPDATE user_product_memberships app
       SET source = CASE parent.product_key
                      WHEN 'personal' THEN 'bonus_personal'
                      WHEN 'nutri'    THEN 'bonus_nutri'
                    END
      FROM user_product_memberships parent
     WHERE app.product_key = 'app'
       AND app.source      = 'corefit'
       AND app.metadata->>'source' = 'connection_request_accept'
       AND parent.user_id     = app.user_id
       AND parent.product_key IN ('personal', 'nutri')
       AND parent.status      = 'active'
  `);
};

/**
 * Reverter reclassificaria como 'corefit' linhas que podem ter nascido
 * corretamente sob o código novo — indistinguíveis das backfilladas. Como o
 * efeito prático de `bonus_*` é apenas HABILITAR a graça no cancelamento
 * (nunca remover acesso por si só), manter é mais seguro que desfazer.
 */
exports.down = async () => {
  // no-op intencional
};
