const TRAINING_PLACES = new Set(['home', 'gym', 'both']);
const TIME_PER_DAY = new Set(['10-15', '20-30', '30-45', '60+']);
const DAYS = new Set([2, 3, 4, 5, 6]);
const BEST_TIME = new Set(['morning', 'afternoon', 'night', 'variable']);
const INTENSITY = new Set(['intense', 'progressive', 'any']);
const EQUIPMENT = new Set(['weights', 'no_weights', 'both']);
const CLOSE = new Set(['yes', 'no']);
const SURGERY = new Set(['yes', 'no']);
const PAIN = new Set(['no', 'sometimes', 'often']);
const INJURY = new Set(['none', 'joelho', 'ombro', 'lombar', 'tornozelo', 'outra']);

export const PARQ_FORM_VERSION = 'parq-pt-acsm-style-v1';
export const PARQ_QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'] as const;

export type OnboardingAnswersInput = {
  trainingPlace: string;
  timePerDay: string;
  injuries: string[];
  surgeryRecent: string;
  frequentPain: string;
  daysPerWeek: number;
  bestTime: string;
  intensityPref: string;
  equipmentPref: string;
  wantsCloseFollow: string;
};

export function parseAndValidateOnboarding(value: unknown): OnboardingAnswersInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Onboarding invalido.');
  }
  const o = value as Record<string, unknown>;

  const trainingPlace = String(o.trainingPlace || '');
  const timePerDay = String(o.timePerDay || '');
  const surgeryRecent = String(o.surgeryRecent || '');
  const frequentPain = String(o.frequentPain || '');
  const bestTime = String(o.bestTime || '');
  const intensityPref = String(o.intensityPref || '');
  const equipmentPref = String(o.equipmentPref || '');
  const wantsCloseFollow = String(o.wantsCloseFollow || '');
  const daysPerWeek = Number(o.daysPerWeek);

  if (!TRAINING_PLACES.has(trainingPlace)) throw new Error('Local de treino invalido.');
  if (!TIME_PER_DAY.has(timePerDay)) throw new Error('Tempo por dia invalido.');
  if (!Number.isInteger(daysPerWeek) || !DAYS.has(daysPerWeek)) throw new Error('Frequencia semanal invalida.');
  if (!BEST_TIME.has(bestTime)) throw new Error('Horario preferido invalido.');
  if (!INTENSITY.has(intensityPref)) throw new Error('Intensidade invalida.');
  if (!EQUIPMENT.has(equipmentPref)) throw new Error('Equipamento invalido.');
  if (!CLOSE.has(wantsCloseFollow)) throw new Error('Acompanhamento invalido.');
  if (!SURGERY.has(surgeryRecent)) throw new Error('Cirurgia recente invalida.');
  if (!PAIN.has(frequentPain)) throw new Error('Dor invalida.');

  const injuries = o.injuries;
  if (!Array.isArray(injuries) || injuries.length === 0) {
    throw new Error('Informe ao menos uma opcao de lesoes (pode ser Nenhuma).');
  }
  for (const item of injuries) {
    if (!INJURY.has(String(item))) {
      throw new Error('Lesao invalida na lista.');
    }
  }

  return {
    trainingPlace,
    timePerDay,
    injuries: injuries.map(String),
    surgeryRecent,
    frequentPain,
    daysPerWeek,
    bestTime,
    intensityPref,
    equipmentPref,
    wantsCloseFollow,
  };
}

export type ParqAnswerInput = { id: string; yes: boolean };

export function parseAndValidateParqAnswers(value: unknown): ParqAnswerInput[] {
  if (!Array.isArray(value) || value.length !== PARQ_QUESTION_IDS.length) {
    throw new Error('Responda todas as perguntas do PAR-Q.');
  }
  const byId = new Map<string, boolean>();
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      throw new Error('PAR-Q invalido.');
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id || '');
    if (!(PARQ_QUESTION_IDS as readonly string[]).includes(id)) {
      throw new Error('PAR-Q: pergunta desconhecida.');
    }
    if (typeof row.yes !== 'boolean') {
      throw new Error('PAR-Q: resposta invalida.');
    }
    byId.set(id, row.yes);
  }
  for (const id of PARQ_QUESTION_IDS) {
    if (!byId.has(id)) {
      throw new Error('PAR-Q incompleto.');
    }
  }
  return PARQ_QUESTION_IDS.map((id) => ({ id, yes: byId.get(id)! }));
}

export function assertParqSignature(dataUrl: string): void {
  const s = String(dataUrl || '').trim();
  if (!s.startsWith('data:image/png;base64,')) {
    throw new Error('Assinatura deve ser uma imagem PNG (canvas).');
  }
  const b64 = s.slice('data:image/png;base64,'.length);
  if (b64.length < 80) {
    throw new Error('Assinatura muito curta. Desenhe no quadro acima.');
  }
  if (s.length > 1_500_000) {
    throw new Error('Assinatura excede o tamanho maximo permitido.');
  }
}
