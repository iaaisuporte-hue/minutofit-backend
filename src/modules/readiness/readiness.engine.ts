export type ReadinessLevel = 'green' | 'yellow' | 'red';

export interface ReadinessFactor {
  id: string;
  label: string;
  severity: 'info' | 'caution' | 'block';
}

export interface ReadinessInput {
  metabolicScore: number;
  metabolismDelta7d: number | null;
  feeling: 'energized' | 'neutral' | 'tired' | null;
  sleptWell: boolean | null;
  inPain: boolean | null;
  stressed: boolean | null;
  nutritionLevel: 'poor' | 'ok' | 'good' | null;
  mentalLoadLevel: 'low' | 'medium' | 'high' | null;
}

export interface ReadinessLens {
  level: ReadinessLevel;
  factors: ReadinessFactor[];
  headline: string;
  microcopy: string;
}

const HEADLINES: Record<ReadinessLevel, string> = {
  green: 'Pronto pra treinar',
  yellow: 'Dia de pegar leve',
  red: 'Hoje é recuperação',
};

const MICROCOPIES: Record<string, string> = {
  'pain.reported':        'Você relatou dor. Evite sobrecarregar o corpo hoje.',
  'metabolic.low':        'Seu metabolismo está baixo. Priorize recuperação.',
  'fatigue.compound':     'Cansaço + sono ruim: alta chance de fadiga acumulada.',
  'metabolic.sharp_drop': 'Queda forte no metabolismo nos últimos dias.',
  'sleep.poor':           'Sono ruim afeta força e recuperação.',
  'energy.low':           'Energia baixa — treino suave protege sua consistência.',
  'mental_load.high':     'Estresse alto e carga mental elevada.',
  'metabolic.drop':       'Metabolismo em queda — sinalize ao seu Personal.',
  'metabolic.moderate_low': 'Metabolismo abaixo do ideal.',
  'nutrition.poor':       'Alimentação ruim compromete a recuperação muscular.',
  'state.nominal':        'Sinais dentro do esperado. Bom treino!',
};

export function computeReadinessLens(input: ReadinessInput): ReadinessLens {
  let level: ReadinessLevel = 'green';
  const factors: ReadinessFactor[] = [];

  function add(id: string, label: string, severity: ReadinessFactor['severity'], newLevel: ReadinessLevel) {
    factors.push({ id, label, severity });
    if (newLevel === 'red') level = 'red';
    else if (newLevel === 'yellow' && level !== 'red') level = 'yellow';
  }

  // ── RED triggers ──────────────────────────────────────────────────────────
  if (input.inPain === true) {
    add('pain.reported', 'Dor relatada', 'block', 'red');
  }
  if (input.metabolicScore <= 30) {
    add('metabolic.low', 'Metabolismo muito baixo', 'block', 'red');
  }
  if (input.feeling === 'tired' && input.sleptWell === false) {
    add('fatigue.compound', 'Fadiga composta (cansaço + sono ruim)', 'block', 'red');
  }
  if (input.metabolismDelta7d !== null && input.metabolismDelta7d <= -20) {
    add('metabolic.sharp_drop', 'Queda acentuada no metabolismo (7d)', 'block', 'red');
  }

  // ── YELLOW triggers (só se não vermelho ainda ou para acumular fatores) ───
  if (input.sleptWell === false && !factors.some(f => f.id === 'fatigue.compound')) {
    add('sleep.poor', 'Sono ruim', 'caution', 'yellow');
  }
  if (input.feeling === 'tired' && !factors.some(f => f.id === 'fatigue.compound')) {
    add('energy.low', 'Energia baixa', 'caution', 'yellow');
  }
  if (input.stressed === true && input.mentalLoadLevel === 'high') {
    add('mental_load.high', 'Estresse + carga mental alta', 'caution', 'yellow');
  }
  if (
    input.metabolismDelta7d !== null &&
    input.metabolismDelta7d <= -10 &&
    input.metabolismDelta7d > -20
  ) {
    add('metabolic.drop', 'Queda no metabolismo (7d)', 'caution', 'yellow');
  }
  if (input.metabolicScore >= 31 && input.metabolicScore <= 44) {
    add('metabolic.moderate_low', 'Metabolismo abaixo do ideal', 'caution', 'yellow');
  }
  if (input.nutritionLevel === 'poor') {
    add('nutrition.poor', 'Alimentação ruim hoje', 'caution', 'yellow');
  }

  if (factors.length === 0) {
    factors.push({ id: 'state.nominal', label: 'Sinais dentro do esperado', severity: 'info' });
  }

  const topFactor = factors.find(f => f.severity === 'block') ?? factors[0];
  const microcopy = MICROCOPIES[topFactor.id] ?? 'Ouça seu corpo e ajuste conforme necessário.';

  return { level, factors, headline: HEADLINES[level], microcopy };
}
