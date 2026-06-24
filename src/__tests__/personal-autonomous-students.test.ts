/**
 * Guard de regressão — "personal autônomo isola por personal_id".
 *
 * INVARIANTE: toda query do dashboard do personal que filtra por `academy_id`
 * DEVE incluir os dados AUTÔNOMOS (`academy_id IS NULL`). Caso contrário, quando
 * o personal tem `activeAcademyId` não-nulo — o que acontece porque
 * `seedDefaultAcademy` vincula TODO usuário à academia padrão e
 * `resolveAcademyContext` então seta esse id no token — os alunos diretos
 * (vínculo com `academy_id = NULL`) somem do dashboard.
 *
 * Bug histórico (jun/2026): "os alunos sumiram no personal". Este teste falha
 * se alguém reintroduzir um filtro `<alias>.academy_id = $N` sem o `IS NULL`,
 * trancando o comportamento que voltou a funcionar.
 *
 * Por que teste estático (lê o source) e não de DB: o CI roda jest sem Postgres;
 * o invariante é uma propriedade do SQL, então o verificamos no texto da query.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE_PATH = join(__dirname, '../services/personalDashboardService.ts');

describe('regressão — personal vê seus alunos autônomos (academy_id NULL)', () => {
  it('todo filtro de academy_id no personalDashboardService inclui IS NULL', () => {
    const src = readFileSync(SERVICE_PATH, 'utf8');
    const offenders: string[] = [];

    src.split('\n').forEach((line, i) => {
      const hasEqualityFilter = /\bacademy_id\s*=\s*\$\d/.test(line);
      const includesNull = /academy_id\s+IS\s+NULL/i.test(line);
      if (hasEqualityFilter && !includesNull) {
        offenders.push(`  L${i + 1}: ${line.trim()}`);
      }
    });

    if (offenders.length > 0) {
      throw new Error(
        'Filtro academy_id SEM `IS NULL` no dashboard do personal — alunos ' +
          'autônomos (academy_id NULL) vão sumir. Use ' +
          '`($N IS NULL OR <alias>.academy_id IS NULL OR <alias>.academy_id = $N)`.\n' +
          offenders.join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });
});
