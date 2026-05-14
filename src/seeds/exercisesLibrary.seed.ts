/**
 * Biblioteca proprietária MetaCore de exercícios.
 * Seed curado com ~60 exercícios prioritários — expandível para 200-500.
 * Schema inspirado no ExerciseDB v2 (external_id = exerciseId ExerciseDB se importado).
 *
 * Campos:
 *  - externalId: identificador externo opcional (null = MetaCore original)
 *  - source: 'metacore' (todos neste seed)
 *  - name: nome PT-BR
 *  - bodyPart: grupo principal (peito, costas, perna, glúteo, ombro, bíceps, tríceps, abdômen, cardio)
 *  - targetMuscle: músculo principal
 *  - secondaryMuscles: músculos secundários
 *  - equipment: equipamento necessário (barra, halteres, máquina, cabo, peso_corporal, etc.)
 *  - instructions: passo a passo (PT-BR)
 *  - tips: dicas técnicas (PT-BR)
 *  - imageUrl / videoUrl: optional (null por padrão — inserir via exercise_media depois)
 */

export type ExerciseSeed = {
  externalId?: string | null;
  source: 'metacore';
  name: string;
  bodyPart: string;
  targetMuscle: string;
  secondaryMuscles: string[];
  equipment: string;
  tags: string[];
  instructions: string[];
  tips: string[];
  imageUrl?: string | null;
  videoUrl?: string | null;
};

export const EXERCISES_SEED: ExerciseSeed[] = [
  // ─── PEITO ───────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Supino Reto',
    bodyPart: 'peito',
    targetMuscle: 'Peitoral maior',
    secondaryMuscles: ['Tríceps braquial', 'Deltoide anterior'],
    equipment: 'barra',
    tags: ['academia', 'hipertrofia', 'força'],
    instructions: [
      'Deite no banco reto, pés apoiados no chão.',
      'Segure a barra com pegada pronada, mãos levemente mais largas que os ombros.',
      'Desça a barra de forma controlada até o peito.',
      'Empurre a barra para cima até estender os cotovelos.',
    ],
    tips: [
      'Mantenha os ombros retraídos e deprimidos durante todo o movimento.',
      'Evite arquear excessivamente a lombar.',
      'Desça a barra até o esterno, não o pescoço.',
    ],
  },
  {
    source: 'metacore',
    name: 'Supino Inclinado com Halteres',
    bodyPart: 'peito',
    targetMuscle: 'Peitoral maior (cabeça clavicular)',
    secondaryMuscles: ['Tríceps braquial', 'Deltoide anterior'],
    equipment: 'halteres',
    tags: ['academia', 'hipertrofia'],
    instructions: [
      'Ajuste o banco a 30–45° de inclinação.',
      'Sente-se com um halter em cada mão apoiado nas coxas.',
      'Deite empurrando os halteres para a posição de trabalho.',
      'Desça os halteres até a linha dos mamilos com cotovelos a 75°.',
      'Empurre de volta até os halteres quase se tocarem no topo.',
    ],
    tips: [
      'Ângulo de 30° ativa mais fibras claviculares sem sobrecarregar o ombro.',
      'Não trave completamente os cotovelos no topo.',
    ],
  },
  {
    source: 'metacore',
    name: 'Crucifixo com Halteres',
    bodyPart: 'peito',
    targetMuscle: 'Peitoral maior',
    secondaryMuscles: ['Bíceps braquial (cabeça curta)', 'Deltoide anterior'],
    equipment: 'halteres',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'Deite no banco plano com um halter em cada mão.',
      'Estique os braços sobre o peito com cotovelos levemente dobrados.',
      'Abra os braços em arco, descendo os halteres até a altura do peito.',
      'Retorne ao ponto inicial contraindo o peitoral.',
    ],
    tips: [
      'Mantenha o leve ângulo do cotovelo constante — não mude no meio do movimento.',
      'Foque na contração do peitoral no topo.',
    ],
  },
  {
    source: 'metacore',
    name: 'Crossover no Cabo',
    bodyPart: 'peito',
    targetMuscle: 'Peitoral maior',
    secondaryMuscles: ['Deltoide anterior'],
    equipment: 'cabo',
    tags: ['academia', 'isolamento', 'definição'],
    instructions: [
      'Posicione as polias na altura dos ombros ou acima.',
      'Segure a alça de cada lado e dê um passo à frente.',
      'Com leve inclinação para frente, cruze os braços à frente do corpo.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Varie a altura das polias para atingir diferentes porções do peitoral.',
      'Foque na fase excêntrica (retorno) para maximizar hipertrofia.',
    ],
  },
  {
    source: 'metacore',
    name: 'Flexão de Braço',
    bodyPart: 'peito',
    targetMuscle: 'Peitoral maior',
    secondaryMuscles: ['Tríceps braquial', 'Deltoide anterior', 'Core'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia', 'funcional'],
    instructions: [
      'Posicione mãos levemente mais largas que os ombros, corpo reto.',
      'Desça o peito até quase tocar o chão.',
      'Empurre de volta à posição inicial.',
    ],
    tips: [
      'Mantenha o core contraído — não deixe o quadril cair.',
      'Varie a largura da pegada para atingir diferentes porções do peitoral.',
    ],
  },
  {
    source: 'metacore',
    name: 'Peck Deck (Máquina)',
    bodyPart: 'peito',
    targetMuscle: 'Peitoral maior',
    secondaryMuscles: ['Deltoide anterior'],
    equipment: 'máquina',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'Sente-se na máquina com costas apoiadas no encosto.',
      'Posicione os antebraços nas almofadas.',
      'Junte os braços à frente do corpo contraindo o peitoral.',
      'Retorne de forma controlada sem deixar as placas baterem.',
    ],
    tips: [
      'Boa opção para iniciantes e isolamento pré-exaustão.',
      'Controle a fase excêntrica em 2–3 segundos.',
    ],
  },
  // ─── COSTAS ──────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Puxada Frente (Lat Pulldown)',
    bodyPart: 'costas',
    targetMuscle: 'Grande dorsal',
    secondaryMuscles: ['Bíceps braquial', 'Redondo maior', 'Rombóide'],
    equipment: 'cabo',
    tags: ['academia', 'hipertrofia', 'força'],
    instructions: [
      'Sente-se na máquina e ajuste o joelheiro para prender as coxas.',
      'Segure a barra com pegada pronada, mãos mais largas que os ombros.',
      'Puxe a barra até o queixo, trazendo os cotovelos para baixo e para trás.',
      'Retorne de forma controlada até estender completamente os braços.',
    ],
    tips: [
      'Não use impulso do corpo — mantenha o tronco levemente inclinado.',
      'Foque em puxar com os cotovelos, não com as mãos.',
    ],
  },
  {
    source: 'metacore',
    name: 'Remada Curvada com Barra',
    bodyPart: 'costas',
    targetMuscle: 'Grande dorsal',
    secondaryMuscles: ['Rombóide', 'Trapézio médio', 'Bíceps braquial', 'Eretores da espinha'],
    equipment: 'barra',
    tags: ['academia', 'hipertrofia', 'força'],
    instructions: [
      'Incline o tronco a 45°, barra nas mãos em pegada pronada.',
      'Puxe a barra em direção ao umbigo.',
      'Comprima as escápulas no final do movimento.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Mantenha a coluna neutra — não arredonde a lombar.',
      'O cotovelo deve passar levemente além das costas no pico.',
    ],
  },
  {
    source: 'metacore',
    name: 'Remada Unilateral com Haltere',
    bodyPart: 'costas',
    targetMuscle: 'Grande dorsal',
    secondaryMuscles: ['Rombóide', 'Trapézio', 'Bíceps braquial'],
    equipment: 'halteres',
    tags: ['academia', 'hipertrofia', 'unilateral'],
    instructions: [
      'Apoie um joelho e a mão no banco.',
      'Segure o halter com a mão oposta, braço estendido.',
      'Puxe o halter em direção ao quadril lateral, cotovelo para trás.',
      'Desça de forma controlada.',
    ],
    tips: [
      'Permita leve rotação do tronco para maior amplitude.',
      'Não deixe o ombro cair no ponto mais baixo.',
    ],
  },
  {
    source: 'metacore',
    name: 'Barra Fixa',
    bodyPart: 'costas',
    targetMuscle: 'Grande dorsal',
    secondaryMuscles: ['Bíceps braquial', 'Braquial', 'Rombóide'],
    equipment: 'peso_corporal',
    tags: ['academia', 'casa', 'funcional', 'força'],
    instructions: [
      'Segure a barra com pegada pronada, mãos mais largas que os ombros.',
      'Pendure-se com os braços estendidos.',
      'Puxe o corpo até o queixo passar a barra.',
      'Desça de forma controlada.',
    ],
    tips: [
      'Escápulas retraídas antes de iniciar o movimento.',
      'Progrida com colete de carga conforme ficar fácil.',
    ],
  },
  {
    source: 'metacore',
    name: 'Remada Baixa no Cabo',
    bodyPart: 'costas',
    targetMuscle: 'Rombóide',
    secondaryMuscles: ['Grande dorsal', 'Trapézio médio', 'Bíceps braquial'],
    equipment: 'cabo',
    tags: ['academia', 'hipertrofia'],
    instructions: [
      'Sente-se na máquina de remada, pés no apoio.',
      'Segure o triângulo ou barra curta.',
      'Puxe em direção ao abdômen comprimindo as escápulas.',
      'Retorne com controle, permitindo leve elongação das costas.',
    ],
    tips: [
      'Evite balançar o tronco para trás — use o core para estabilização.',
    ],
  },
  // ─── PERNA ───────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Agachamento Livre',
    bodyPart: 'perna',
    targetMuscle: 'Quadríceps',
    secondaryMuscles: ['Glúteo máximo', 'Isquiotibiais', 'Eretores da espinha', 'Core'],
    equipment: 'barra',
    tags: ['academia', 'composto', 'força', 'hipertrofia'],
    instructions: [
      'Posicione a barra no trapézio baixo (high bar) ou médio.',
      'Pés na largura dos ombros, pontas levemente para fora.',
      'Desça controladamente até as coxas ficarem paralelas ao chão.',
      'Suba empurrando o chão, mantendo o joelho alinhado com o pé.',
    ],
    tips: [
      'Joelhos não devem colapsar para dentro.',
      'Mantenha o peito alto durante todo o movimento.',
      'Respire fundo antes de descer (manobra de Valsalva).',
    ],
  },
  {
    source: 'metacore',
    name: 'Leg Press 45°',
    bodyPart: 'perna',
    targetMuscle: 'Quadríceps',
    secondaryMuscles: ['Glúteo máximo', 'Isquiotibiais', 'Panturrilha'],
    equipment: 'máquina',
    tags: ['academia', 'hipertrofia'],
    instructions: [
      'Sente na plataforma com os pés na largura dos ombros na plataforma.',
      'Desça a plataforma até os joelhos formarem ≈ 90°.',
      'Empurre a plataforma de volta sem travar completamente os joelhos.',
    ],
    tips: [
      'Não deixe os joelhos colapsarem para dentro.',
      'Quanto mais alto os pés, maior ativação de glúteo/isquiotibiais.',
    ],
  },
  {
    source: 'metacore',
    name: 'Cadeira Extensora',
    bodyPart: 'perna',
    targetMuscle: 'Quadríceps',
    secondaryMuscles: [],
    equipment: 'máquina',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'Sente na cadeira, tornozelos apoiados no rolo.',
      'Estenda os joelhos contraindo os quadríceps.',
      'Retorne de forma controlada sem bater o peso.',
    ],
    tips: [
      'Mantenha contração isométrica de 1–2s no pico.',
      'Cuidado com excesso de carga se houver histórico de joelho.',
    ],
  },
  {
    source: 'metacore',
    name: 'Mesa Flexora (Leg Curl Deitado)',
    bodyPart: 'perna',
    targetMuscle: 'Isquiotibiais',
    secondaryMuscles: ['Panturrilha (gastrocnêmio)'],
    equipment: 'máquina',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'Deite na máquina, tornozelos sob o rolo.',
      'Contraia os isquiotibiais flexionando os joelhos.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Não levante o quadril para conseguir mais amplitude.',
      'Fase excêntrica lenta (3–4s) maximiza hipertrofia.',
    ],
  },
  {
    source: 'metacore',
    name: 'Stiff (Romanian Deadlift)',
    bodyPart: 'perna',
    targetMuscle: 'Isquiotibiais',
    secondaryMuscles: ['Glúteo máximo', 'Eretores da espinha'],
    equipment: 'barra',
    tags: ['academia', 'hipertrofia', 'força'],
    instructions: [
      'Segure a barra na frente das coxas, pés na largura dos quadris.',
      'Incline o tronco para frente empurrando o quadril para trás.',
      'Desça a barra ao longo das pernas até sentir alongamento nos isquiotibiais.',
      'Retorne empurrando o quadril para frente.',
    ],
    tips: [
      'Mantenha leve flexão nos joelhos (não é levantamento terra).',
      'Costas retas durante todo o movimento.',
    ],
  },
  {
    source: 'metacore',
    name: 'Afundo (Lunge)',
    bodyPart: 'perna',
    targetMuscle: 'Quadríceps',
    secondaryMuscles: ['Glúteo máximo', 'Isquiotibiais'],
    equipment: 'halteres',
    tags: ['academia', 'casa', 'funcional', 'unilateral'],
    instructions: [
      'Em pé com halteres nas mãos, dê um passo à frente.',
      'Desça o joelho traseiro em direção ao chão.',
      'Volte à posição inicial empurrando pelo calcanhar do pé da frente.',
    ],
    tips: [
      'Joelho da frente não deve ultrapassar a ponta do pé.',
      'Mantenha o tronco ereto.',
    ],
  },
  {
    source: 'metacore',
    name: 'Panturrilha em Pé (Calf Raise)',
    bodyPart: 'perna',
    targetMuscle: 'Gastrocnêmio',
    secondaryMuscles: ['Sóleo'],
    equipment: 'máquina',
    tags: ['academia', 'isolamento'],
    instructions: [
      'Posicione os ombros sob os apoios, pontas dos pés na plataforma.',
      'Suba nas pontas dos pés contraindo a panturrilha.',
      'Desça até sentir alongamento do calcanhar abaixo da plataforma.',
    ],
    tips: [
      'Amplitude total é essencial — panturrilha responde bem a volume e amplitude.',
      '3–4 séries de 15–25 reps funciona bem.',
    ],
  },
  // ─── GLÚTEO ───────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Elevação Pélvica (Hip Thrust)',
    bodyPart: 'glúteo',
    targetMuscle: 'Glúteo máximo',
    secondaryMuscles: ['Isquiotibiais', 'Core'],
    equipment: 'barra',
    tags: ['academia', 'hipertrofia', 'glúteo'],
    instructions: [
      'Apoie as escápulas em banco, barra sobre o colo com proteção.',
      'Pés no chão, joelhos a 90°.',
      'Empurre o quadril para cima contraindo glúteos.',
      'Desça controladamente.',
    ],
    tips: [
      'Mantenha queixo no peito para não estender a cervical.',
      'No topo, pernas e tronco formam linha reta — não hiperstenda a lombar.',
    ],
  },
  {
    source: 'metacore',
    name: 'Abdução de Quadril na Máquina',
    bodyPart: 'glúteo',
    targetMuscle: 'Glúteo médio',
    secondaryMuscles: ['Glúteo mínimo', 'TFL'],
    equipment: 'máquina',
    tags: ['academia', 'isolamento', 'glúteo'],
    instructions: [
      'Sente na máquina com coxas apoiadas nas almofadas.',
      'Abra as pernas contra a resistência.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Adicione contração isométrica de 1s na abertura máxima.',
    ],
  },
  {
    source: 'metacore',
    name: 'Agachamento Sumô',
    bodyPart: 'glúteo',
    targetMuscle: 'Glúteo máximo',
    secondaryMuscles: ['Adutores', 'Quadríceps', 'Isquiotibiais'],
    equipment: 'halteres',
    tags: ['academia', 'casa', 'glúteo'],
    instructions: [
      'Pés mais largos que os ombros, pontas bem abertas.',
      'Segure um halter com ambas as mãos entre as pernas.',
      'Desça mantendo o tronco ereto.',
      'Suba empurrando pelos calcanhares.',
    ],
    tips: [
      'Joelhos seguem a direção das pontas dos pés.',
    ],
  },
  // ─── OMBRO ────────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Desenvolvimento com Halteres',
    bodyPart: 'ombro',
    targetMuscle: 'Deltoide medial',
    secondaryMuscles: ['Deltoide anterior', 'Tríceps braquial', 'Trapézio'],
    equipment: 'halteres',
    tags: ['academia', 'hipertrofia', 'força'],
    instructions: [
      'Sente no banco com encosto, halteres ao nível dos ombros.',
      'Empurre os halteres acima da cabeça até quase tocar.',
      'Desça controladamente até os cotovelos ficarem um pouco abaixo dos ombros.',
    ],
    tips: [
      'Não bloqueie totalmente os cotovelos no topo.',
      'Leve arco lombar natural — não exagere.',
    ],
  },
  {
    source: 'metacore',
    name: 'Elevação Lateral',
    bodyPart: 'ombro',
    targetMuscle: 'Deltoide medial',
    secondaryMuscles: ['Deltoide anterior', 'Trapézio'],
    equipment: 'halteres',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'Em pé, halteres ao lado do corpo.',
      'Eleve os braços lateralmente até a altura dos ombros.',
      'Desça controladamente.',
    ],
    tips: [
      'Cotovelos levemente dobrados durante o movimento.',
      'Fique com as mãos levemente abaixadas no pico (como despejar líquido) para maior ativação medial.',
    ],
  },
  {
    source: 'metacore',
    name: 'Elevação Frontal',
    bodyPart: 'ombro',
    targetMuscle: 'Deltoide anterior',
    secondaryMuscles: ['Peitoral (feixe clavicular)', 'Trapézio'],
    equipment: 'halteres',
    tags: ['academia', 'isolamento'],
    instructions: [
      'Em pé, halteres à frente das coxas.',
      'Eleve um ou ambos os braços à frente até a altura dos ombros.',
      'Desça de forma controlada.',
    ],
    tips: [
      'Evite balançar o corpo para ganhar impulso.',
    ],
  },
  {
    source: 'metacore',
    name: 'Crucifixo Inverso (Elevação Posterior)',
    bodyPart: 'ombro',
    targetMuscle: 'Deltoide posterior',
    secondaryMuscles: ['Rombóide', 'Trapézio médio'],
    equipment: 'halteres',
    tags: ['academia', 'isolamento', 'postura'],
    instructions: [
      'Incline o tronco a 45°, halteres nas mãos.',
      'Eleve os braços lateralmente em arco até a altura dos ombros.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Cotovelos levemente dobrados.',
      'Excelente para equilíbrio entre anterior e posterior do ombro.',
    ],
  },
  {
    source: 'metacore',
    name: 'Arnold Press',
    bodyPart: 'ombro',
    targetMuscle: 'Deltoide (todos os feixes)',
    secondaryMuscles: ['Tríceps braquial', 'Trapézio'],
    equipment: 'halteres',
    tags: ['academia', 'hipertrofia'],
    instructions: [
      'Sente com halteres à frente, palmas para o corpo.',
      'Ao pressionar para cima, gire as palmas para fora.',
      'No topo, palmas para frente. Inverta na descida.',
    ],
    tips: [
      'Movimento de rotação ativa todos os três feixes do deltoide.',
    ],
  },
  // ─── BÍCEPS ───────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Rosca Direta com Barra',
    bodyPart: 'bíceps',
    targetMuscle: 'Bíceps braquial',
    secondaryMuscles: ['Braquial', 'Braquiorradial'],
    equipment: 'barra',
    tags: ['academia', 'hipertrofia', 'força'],
    instructions: [
      'Em pé, barra em pegada supinada na largura dos ombros.',
      'Flexione os cotovelos trazendo a barra em direção aos ombros.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Cotovelos fixos ao lado do corpo.',
      'Evite balançar o tronco.',
    ],
  },
  {
    source: 'metacore',
    name: 'Rosca Alternada com Halteres',
    bodyPart: 'bíceps',
    targetMuscle: 'Bíceps braquial',
    secondaryMuscles: ['Braquial', 'Braquiorradial'],
    equipment: 'halteres',
    tags: ['academia', 'casa', 'hipertrofia'],
    instructions: [
      'Em pé ou sentado, halter em cada mão.',
      'Flexione um cotovelo de cada vez, girando a palma para cima.',
      'Retorne e alterne os lados.',
    ],
    tips: [
      'Supinação máxima no pico da contração ativa mais fibras do bíceps.',
    ],
  },
  {
    source: 'metacore',
    name: 'Rosca Martelo',
    bodyPart: 'bíceps',
    targetMuscle: 'Braquiorradial',
    secondaryMuscles: ['Bíceps braquial', 'Braquial'],
    equipment: 'halteres',
    tags: ['academia', 'hipertrofia'],
    instructions: [
      'Em pé, halteres em pegada neutra (polegar para cima).',
      'Flexione os cotovelos sem girar os pulsos.',
      'Retorne de forma controlada.',
    ],
    tips: [
      'Excelente para espessura do braço, diferente da rosca direta.',
    ],
  },
  {
    source: 'metacore',
    name: 'Rosca Scott (Preacher Curl)',
    bodyPart: 'bíceps',
    targetMuscle: 'Bíceps braquial (cabeça curta)',
    secondaryMuscles: ['Braquial'],
    equipment: 'barra',
    tags: ['academia', 'isolamento'],
    instructions: [
      'Apoie os braços no banco Scott, barra em pegada supinada.',
      'Flexione os cotovelos trazendo a barra em direção ao rosto.',
      'Retorne sem estender completamente o cotovelo.',
    ],
    tips: [
      'Não deixe a barra cair de forma abrupta — cuidado com lesão.',
    ],
  },
  // ─── TRÍCEPS ──────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Tríceps Corda (Pushdown)',
    bodyPart: 'tríceps',
    targetMuscle: 'Tríceps braquial',
    secondaryMuscles: [],
    equipment: 'cabo',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'De pé na polia alta, segure a corda na largura dos ombros.',
      'Empurre a corda para baixo estendendo os cotovelos.',
      'Abra as duas pontas da corda no final para maior ativação.',
      'Retorne controladamente.',
    ],
    tips: [
      'Cotovelos fixos ao lado do corpo.',
    ],
  },
  {
    source: 'metacore',
    name: 'Tríceps Testa (Skull Crusher)',
    bodyPart: 'tríceps',
    targetMuscle: 'Tríceps braquial',
    secondaryMuscles: [],
    equipment: 'barra',
    tags: ['academia', 'hipertrofia'],
    instructions: [
      'Deite no banco plano, barra acima do peito.',
      'Flexione os cotovelos descendo a barra em direção à testa.',
      'Estenda de volta à posição inicial.',
    ],
    tips: [
      'Cotovelos apontados para o teto — não deixe abrir.',
      'Use barra EZ para reduzir stress no punho.',
    ],
  },
  {
    source: 'metacore',
    name: 'Tríceps Francês com Haltere',
    bodyPart: 'tríceps',
    targetMuscle: 'Tríceps braquial (cabeça longa)',
    secondaryMuscles: [],
    equipment: 'halteres',
    tags: ['academia', 'isolamento', 'hipertrofia'],
    instructions: [
      'Sentado, segure um halter com ambas as mãos acima da cabeça.',
      'Desça o halter atrás da cabeça flexionando os cotovelos.',
      'Estenda de volta ao topo.',
    ],
    tips: [
      'Ativa fortemente a cabeça longa do tríceps (maior volume).',
    ],
  },
  {
    source: 'metacore',
    name: 'Mergulho (Tríceps Dip)',
    bodyPart: 'tríceps',
    targetMuscle: 'Tríceps braquial',
    secondaryMuscles: ['Peitoral menor', 'Deltoide anterior'],
    equipment: 'peso_corporal',
    tags: ['academia', 'casa', 'funcional'],
    instructions: [
      'Apoie as mãos em barras paralelas ou banco, corpo ereto.',
      'Desça flexionando os cotovelos até 90°.',
      'Empurre de volta à posição inicial.',
    ],
    tips: [
      'Tronco ereto = mais foco em tríceps; inclinado para frente = mais peitoral.',
    ],
  },
  // ─── ABDÔMEN ──────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Prancha Isométrica',
    bodyPart: 'abdômen',
    targetMuscle: 'Core (transverso abdominal)',
    secondaryMuscles: ['Reto abdominal', 'Oblíquos', 'Glúteo médio'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia', 'funcional', 'estabilização'],
    instructions: [
      'Apoie-se nos antebraços e pontas dos pés, corpo reto.',
      'Contraia o abdômen e glúteos.',
      'Mantenha a posição pelo tempo determinado.',
    ],
    tips: [
      'Não deixe o quadril subir ou cair.',
      'Progrida em tempo: 30s → 45s → 60s → 90s.',
    ],
  },
  {
    source: 'metacore',
    name: 'Crunch Abdominal',
    bodyPart: 'abdômen',
    targetMuscle: 'Reto abdominal',
    secondaryMuscles: ['Oblíquos'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia'],
    instructions: [
      'Deite com joelhos dobrados, pés no chão.',
      'Mãos na nuca ou cruzadas no peito.',
      'Eleve o tronco contraindo o abdômen até os ombros saírem do chão.',
      'Retorne controladamente.',
    ],
    tips: [
      'Evite puxar o pescoço com as mãos.',
      'Enfatize a contração, não a amplitude.',
    ],
  },
  {
    source: 'metacore',
    name: 'Abdominal Infra (Elevação de Pernas)',
    bodyPart: 'abdômen',
    targetMuscle: 'Reto abdominal inferior',
    secondaryMuscles: ['Flexores do quadril'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia'],
    instructions: [
      'Deite com as costas no chão, mãos ao lado do corpo.',
      'Eleve as pernas estendidas até 90°.',
      'Desça controladamente sem tocar o chão.',
    ],
    tips: [
      'Se a lombar sair do chão, flexione levemente os joelhos.',
    ],
  },
  {
    source: 'metacore',
    name: 'Oblíquo com Rotação',
    bodyPart: 'abdômen',
    targetMuscle: 'Oblíquo externo',
    secondaryMuscles: ['Oblíquo interno', 'Reto abdominal'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia'],
    instructions: [
      'Deite com joelhos dobrados.',
      'Eleve o tronco girando o cotovelo em direção ao joelho oposto.',
      'Alterne os lados.',
    ],
    tips: [
      'Rotação vem do tronco, não do pescoço.',
    ],
  },
  // ─── CARDIO / FUNCIONAL ────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Esteira (HIIT)',
    bodyPart: 'cardio',
    targetMuscle: 'Sistema cardiovascular',
    secondaryMuscles: ['Quadríceps', 'Isquiotibiais', 'Panturrilha'],
    equipment: 'esteira',
    tags: ['academia', 'cardio', 'hiit', 'emagrecimento'],
    instructions: [
      'Aqueça 3 min em ritmo moderado.',
      'Alterne 30s de sprint intenso (85–95% FCmax) com 60s de caminhada.',
      'Repita 6–10 ciclos.',
      'Desacelere 3 min no final.',
    ],
    tips: [
      'Monitore a FC para garantir a intensidade correta nos sprints.',
    ],
  },
  {
    source: 'metacore',
    name: 'Burpee',
    bodyPart: 'cardio',
    targetMuscle: 'Sistema cardiovascular',
    secondaryMuscles: ['Peitoral', 'Quadríceps', 'Core', 'Deltoide'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia', 'hiit', 'funcional', 'emagrecimento'],
    instructions: [
      'Em pé, desça agachando e apoie as mãos no chão.',
      'Jogue os pés para trás, chegando em posição de flexão.',
      'Faça uma flexão (opcional).',
      'Traga os pés de volta ao agachamento e suba em salto com braços acima.',
    ],
    tips: [
      'Mantenha o abdômen contraído durante toda a sequência.',
    ],
  },
  {
    source: 'metacore',
    name: 'Mountain Climber',
    bodyPart: 'cardio',
    targetMuscle: 'Core',
    secondaryMuscles: ['Flexores do quadril', 'Deltoide', 'Peitoral'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia', 'funcional', 'cardio'],
    instructions: [
      'Posição de prancha, braços estendidos.',
      'Traga um joelho em direção ao peito alternando os lados rapidamente.',
    ],
    tips: [
      'Quadril nivelado — não deixe oscilar para os lados.',
    ],
  },
  {
    source: 'metacore',
    name: 'Jumping Jacks',
    bodyPart: 'cardio',
    targetMuscle: 'Sistema cardiovascular',
    secondaryMuscles: ['Glúteo médio', 'Deltoide'],
    equipment: 'peso_corporal',
    tags: ['casa', 'aquecimento', 'cardio'],
    instructions: [
      'Em pé, braços ao lado do corpo.',
      'Salte abrindo pernas e levantando os braços acima da cabeça.',
      'Salte de volta à posição inicial.',
    ],
    tips: [
      'Ótimo exercício de aquecimento — 2-3 min despertam a FC.',
    ],
  },
  // ─── CASA ─────────────────────────────────────────────────────────────────
  {
    source: 'metacore',
    name: 'Agachamento Livre (Peso Corporal)',
    bodyPart: 'perna',
    targetMuscle: 'Quadríceps',
    secondaryMuscles: ['Glúteo máximo', 'Isquiotibiais'],
    equipment: 'peso_corporal',
    tags: ['casa', 'funcional', 'aquecimento'],
    instructions: [
      'Pés na largura dos ombros, pontas levemente abertas.',
      'Desça como se fosse sentar em uma cadeira.',
      'Suba empurrando pelos calcanhares.',
    ],
    tips: [
      'Braços à frente para equilíbrio.',
    ],
  },
  {
    source: 'metacore',
    name: 'Glúteo 4 Apoios (Donkey Kick)',
    bodyPart: 'glúteo',
    targetMuscle: 'Glúteo máximo',
    secondaryMuscles: ['Isquiotibiais'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia', 'glúteo', 'isolamento'],
    instructions: [
      'Apoie-se em quatro apoios (mãos e joelhos).',
      'Chute uma perna para trás e para cima, contraindo o glúteo.',
      'Retorne sem tocar o joelho no chão e repita.',
    ],
    tips: [
      'Não gire o quadril — mantenha estável.',
    ],
  },
  {
    source: 'metacore',
    name: 'Flexão Diamante',
    bodyPart: 'tríceps',
    targetMuscle: 'Tríceps braquial',
    secondaryMuscles: ['Peitoral (feixe esternal)'],
    equipment: 'peso_corporal',
    tags: ['casa', 'academia', 'funcional'],
    instructions: [
      'Posição de flexão com mãos juntas formando losango.',
      'Desça o peito em direção às mãos.',
      'Empurre de volta.',
    ],
    tips: [
      'Cotovelos colados ao corpo durante o movimento.',
    ],
  },
];
