/**
 * Seed — templates de mensagem CoreFit (scope='corefit').
 * Visíveis para todos os personals, não editáveis (escopo corefit).
 * Copy em PT-BR humano, tom de acompanhamento — não CRM frio.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  const now = pgm.func('NOW()');

  const templates = [
    {
      category: 'aluno_ausente_amigavel',
      title: 'Oi, sumiu! 😄',
      body: 'Oi, [nome]! Vi que faz alguns dias sem treinar — está tudo bem?\nSe quiser, podemos ajustar o ritmo essa semana, fazer algo mais leve ou só bater um papo sobre como você está se sentindo.',
      is_default: true,
    },
    {
      category: 'retorno_progressivo',
      title: 'Retorno gradual',
      body: 'Oi, [nome]! Que tal um retorno mais tranquilo essa semana?\nMontei uma ideia de sessão mais leve para você voltar sem pressão — o importante é retomar o movimento, não o volume.',
      is_default: false,
    },
    {
      category: 'treino_regenerativo',
      title: 'Treino regenerativo',
      body: 'Oi, [nome]! Percebi que seu corpo pode estar pedindo uma semana de recuperação.\nQue tal um treino mais suave, com foco em mobilidade e qualidade de movimento? Às vezes descansar estrategicamente é o melhor treino.',
      is_default: false,
    },
    {
      category: 'parabens_consistencia',
      title: 'Parabéns pela consistência',
      body: 'Oi, [nome]! Só queria te dar um parabéns — você está mostrando consistência incrível nas últimas semanas.\nEssa regularidade é o que realmente transforma. Continue assim! 💪',
      is_default: false,
    },
    {
      category: 'convite_check_in',
      title: 'Como você está?',
      body: 'Oi, [nome]! Como você está se sentindo essa semana?\nSono, energia, disposição — qualquer sinal importa para ajustar seu treino da forma certa. Me conta!',
      is_default: false,
    },
    {
      category: 'oferta_bonus_leve',
      title: 'Sessão bônus',
      body: 'Oi, [nome]! Tenho um horário extra essa semana se você quiser encaixar uma sessão adicional.\nSem pressão — pode ser algo leve, focado no que você precisar. O que acha?',
      is_default: false,
    },
  ];

  for (const t of templates) {
    pgm.sql(`
      INSERT INTO personal_message_templates
        (personal_id, academy_id, scope, category, title, body, is_default, created_at, updated_at)
      VALUES
        (NULL, NULL, 'corefit', '${t.category}', ${pgm.func(`'${t.title.replace(/'/g, "''")}'`)}, ${pgm.func(`'${t.body.replace(/'/g, "''")}'`)}, ${t.is_default}, NOW(), NOW())
      ON CONFLICT DO NOTHING;
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM personal_message_templates WHERE scope = 'corefit';`);
};
