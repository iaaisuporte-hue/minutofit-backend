/**
 * Encerramento de academia: trilha preservada, operacional removido
 * (Spec 034, Onda C3).
 *
 * ## O defeito que isto fecha
 *
 * **Excluir uma academia era impossível.** `academy_roles.academy_id` é
 * `ON DELETE CASCADE`, e a tabela tem um gatilho de auditoria
 * (`fn_audit_academy_role`) que insere em `academy_role_audit` a cada
 * INSERT/UPDATE/DELETE. Durante o cascade, o gatilho tentava gravar uma linha
 * de auditoria com `academy_id` apontando para a academia que estava sendo
 * removida na mesma transação — e a FK do próprio audit recusava:
 *
 *     insert or update on table "academy_role_audit" violates foreign key
 *     constraint "academy_role_audit_academy_id_fkey"
 *
 * Ninguém tinha exercido a exclusão de academia em teste, exatamente como o
 * `DELETE /api/user/account` da validação de 02/ago — que respondia 500 em
 * 100% das contas desde o cadastro, pelo mesmo motivo.
 *
 * ## A semântica, e por que não é tudo igual
 *
 * `academy_role_audit` é **trilha de auditoria**: ela existe para responder
 * "quem mudou o quê" depois do fato, inclusive depois de a academia sumir.
 * Apagá-la junto destruiria a evidência — mesmo raciocínio da migration 1822,
 * que preservou `data_access_audit` na exclusão de conta.
 *
 * Aqui as FKs são **removidas**, não afrouxadas para `SET NULL`. `SET NULL`
 * não resolveria: a ação de delete só vale quando o pai é apagado, e o
 * problema é o INSERT do gatilho referenciando uma linha que já sumiu na mesma
 * transação — isso viola a FK independentemente da ação configurada.
 *
 * Uma trilha de auditoria que depende da existência do que ela audita é uma
 * contradição: o registro precisa sobreviver justamente ao caso em que o
 * objeto deixou de existir. As colunas continuam lá, com os índices, e
 * `old_data`/`new_data` guardam o conteúdo histórico completo.
 *
 * `challenges` é o oposto: **entidade operacional**. Um desafio institucional
 * sem tenant dono é entidade social órfã carregando dado pessoal de
 * terceiros. A coluna ganha FK `ON DELETE CASCADE` — que ela nunca teve, um
 * segundo buraco: nada impedia gravar `academy_id` de uma academia
 * inexistente. Os participantes vão junto pelo CASCADE que já existe.
 *
 * O XP já pago fica: ele é do titular de cada participante, não do desafio.
 *
 * ## `created_by_user_id` deixa de destruir o desafio
 *
 * A coluna nasceu `ON DELETE CASCADE` na 1829. Consequência: o gerente que
 * excluísse a própria conta apagaria o desafio institucional E todas as linhas
 * de participação — incluindo o `final_pct` de quem concluiu — num tenant que
 * continua existindo. O aluno ficaria com o XP creditado e sem o fato que o
 * justifica.
 *
 * Vira `SET NULL`: a academia é a dona, o funcionário é apenas quem clicou. É
 * o mesmo tratamento que a 1822 deu à autoria de trilha.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── Trilha de auditoria sobrevive ao tenant ──────────────────────────────
  await pgm.db.query(`
    ALTER TABLE academy_role_audit
      DROP CONSTRAINT IF EXISTS academy_role_audit_academy_id_fkey,
      DROP CONSTRAINT IF EXISTS academy_role_audit_role_id_fkey`);

  // Sem FK: os ids viram referência histórica, não vínculo vivo.

  // ── Desafio institucional não sobrevive ao dono ──────────────────────────
  await pgm.db.query(`
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_academy_id_fkey`);

  // Linhas apontando para academia inexistente impediriam criar a FK. Não
  // deveriam existir (a coluna nunca teve FK), e um desafio de tenant que não
  // existe é justamente o que esta migration elimina.
  await pgm.db.query(`
    DELETE FROM challenges
     WHERE academy_id IS NOT NULL
       AND academy_id NOT IN (SELECT id FROM academies)`);

  await pgm.db.query(`
    ALTER TABLE challenges
      ADD CONSTRAINT challenges_academy_id_fkey
        FOREIGN KEY (academy_id) REFERENCES academies(id) ON DELETE CASCADE`);

  // ── Autoria não é propriedade ────────────────────────────────────────────
  await pgm.db.query(`
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_created_by_user_id_fkey`);
  await pgm.db.query(`ALTER TABLE challenges ALTER COLUMN created_by_user_id DROP NOT NULL`);
  await pgm.db.query(`
    ALTER TABLE challenges
      ADD CONSTRAINT challenges_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_academy_id_fkey`);

  // Volta ao CASCADE original. Desafios com autoria já nula não conseguiriam
  // satisfazer o NOT NULL — são removidos, porque no schema antigo eles não
  // podiam existir.
  await pgm.db.query(`
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_created_by_user_id_fkey`);
  await pgm.db.query(`DELETE FROM challenges WHERE created_by_user_id IS NULL`);
  await pgm.db.query(`ALTER TABLE challenges ALTER COLUMN created_by_user_id SET NOT NULL`);
  await pgm.db.query(`
    ALTER TABLE challenges
      ADD CONSTRAINT challenges_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE`);

  await pgm.db.query(`
    ALTER TABLE academy_role_audit
      DROP CONSTRAINT IF EXISTS academy_role_audit_academy_id_fkey,
      DROP CONSTRAINT IF EXISTS academy_role_audit_role_id_fkey`);

  // Restaura as FKs originais. Linhas de auditoria acumuladas enquanto elas
  // não existiam podem apontar para academias já removidas, e a constraint
  // voltaria violada — por isso o rollback as descarta primeiro. É perda de
  // trilha, e é o preço de voltar a um schema que não a sustentava.
  await pgm.db.query(`
    DELETE FROM academy_role_audit
     WHERE (academy_id IS NOT NULL AND academy_id NOT IN (SELECT id FROM academies))
        OR (role_id    IS NOT NULL AND role_id    NOT IN (SELECT id FROM academy_roles))`);

  await pgm.db.query(`
    ALTER TABLE academy_role_audit
      ADD CONSTRAINT academy_role_audit_academy_id_fkey
        FOREIGN KEY (academy_id) REFERENCES academies(id),
      ADD CONSTRAINT academy_role_audit_role_id_fkey
        FOREIGN KEY (role_id) REFERENCES academy_roles(id)`);
};
