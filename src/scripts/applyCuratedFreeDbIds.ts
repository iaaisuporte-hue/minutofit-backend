/**
 * applyCuratedFreeDbIds.ts
 *
 * Aplica mapeamentos curados manualmente (PT→freeDbId) nos exercícios sem mídia.
 * Seguro para rodar múltiplas vezes (idempotente): só insere onde não existe.
 *
 * Uso: npx tsx src/scripts/applyCuratedFreeDbIds.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const SEED_PATH = path.join(__dirname, '../seeds/exercisesLibrary.seed.ts');

/**
 * Mapeamento curado: nome PT-BR → freeDbId do free-exercise-db
 * IDs verificados contra freeExerciseDb.snapshot.json
 */
const CURATED: Record<string, string> = {
  // ─── Peitoral ───────────────────────────────────────────────────────────────
  'Supino Reto com Halteres':                     'Dumbbell_Bench_Press',

  // ─── Costas ─────────────────────────────────────────────────────────────────
  'Remada Baixa no Cabo':                          'Low_Pulley_Row_To_Neck',
  'Remada Alta no Cabo':                           'Kneeling_High_Pulley_Row',
  'Remada com Elástico':                           'Bent_Over_Two-Dumbbell_Row',
  'Remada com Elástico na Porta':                  'Alternating_Kettlebell_Row',

  // ─── Pernas ─────────────────────────────────────────────────────────────────
  'Leg Press 45°':                                 'Leg_Press',
  'Cadeira Extensora':                             'Leg_Extensions',
  'Afundo (Lunge)':                                'Dumbbell_Lunges',
  'Afundo Reverso':                                'Dumbbell_Rear_Lunge',
  'Agachamento Sumô':                              'Plie_Dumbbell_Squat',
  'Agachamento Sumo':                              'Plie_Dumbbell_Squat',
  'Agachamento Livre (Peso Corporal)':             'Bodyweight_Squat',
  'Agachamento Búlgaro':                           'Split_Squat_with_Dumbbells',
  'Agachamento com Rotação de Ombro':              'Overhead_Squat',
  'Pistol Squat (Agachamento Unilateral)':         'Kettlebell_Pistol_Squat',
  'Cossack Squat (Agachamento Lateral)':           'Barbell_Side_Split_Squat',
  'Chair Squat (Agachamento na Cadeira)':          'Chair_Squat',
  'Terra Sumo':                                    'Sumo_Deadlift',
  'Nordic Curl (Curl Nórdico)':                    'Lying_Machine_Squat',
  'Wall Sit (Cadeira na Parede)':                  'Sit_Squats',
  'Frog Jump (Salto Sapo)':                        'Weighted_Jump_Squat',
  'Tuck Jump':                                     'Knee_Tuck_Jump',
  'Box Jump':                                      'Front_Box_Jump',

  // ─── Panturrilha ────────────────────────────────────────────────────────────
  'Panturrilha em Pé (Calf Raise)':               'Rocking_Standing_Calf_Raise',

  // ─── Quadril / Glúteo ───────────────────────────────────────────────────────
  'Abdução de Quadril na Máquina':                 'Thigh_Adductor',
  'Abdução na Máquina':                            'Thigh_Adductor',
  'Cadeira Adutora':                               'Adductor',
  'Abdução com Elástico (Monster Walk)':           'Monster_Walk',
  'Glúteo 4 Apoios (Donkey Kick)':                'Glute_Kickback',
  'Glute Kickback de Joelhos':                     'Glute_Kickback',
  'Extensão de Quadril em Pé':                     'Hip_Extension_with_Bands',
  'Thruster (Agachamento + Press)':                'Barbell_Hip_Thrust',

  // ─── Ombros ─────────────────────────────────────────────────────────────────
  'Arnold Press':                                  'Arnold_Dumbbell_Press',
  'Elevação Frontal':                              'Front_Raise_And_Pullover',
  'Elevação Frontal com Halteres':                 'Front_Raise_And_Pullover',
  'Encolhimento de Ombros com Halteres':           'Dumbbell_Shrug',
  'Desenvolvimento com Barra (Press Militar)':     'Seated_Barbell_Military_Press',
  'Rotação Interna/Externa com Elástico':          'External_Rotation_with_Band',
  'Mobilidade de Ombro (Towel Stretch)':           'Chest_And_Front_Of_Shoulder_Stretch',
  'Rotação de Braços':                             'Chest_And_Front_Of_Shoulder_Stretch',

  // ─── Bíceps ─────────────────────────────────────────────────────────────────
  'Rosca Alternada com Halteres':                  'Dumbbell_Alternate_Bicep_Curl',
  'Rosca Martelo':                                 'Hammer_Curls',
  'Rosca com Cabo (Cross Body)':                   'Cross_Body_Hammer_Curl',
  'Rosca de Punho':                                'Palms-Down_Dumbbell_Wrist_Curl_Over_A_Bench',
  'Rosca com Elástico':                            'Cable_Preacher_Curl',
  'Rosca 21 com Barra':                            'Barbell_Curl',

  // ─── Antebraço / Punho ──────────────────────────────────────────────────────
  'Extensão de Punho':                             'Palms-Down_Dumbbell_Wrist_Curl_Over_A_Bench',
  'Pronação e Supinação com Haltere':              'Seated_Dumbbell_Palms-Down_Wrist_Curl',

  // ─── Tríceps ─────────────────────────────────────────────────────────────────
  'Tríceps Corda (Pushdown)':                      'Triceps_Pushdown_-_Rope_Attachment',
  'Tríceps Francês com Haltere':                   'Overhead_Triceps',
  'Mergulho (Tríceps Dip)':                        'Dips_-_Triceps_Version',
  'Tríceps com Elástico':                          'Speed_Band_Overhead_Triceps',
  'Extensão de Tríceps com Haltere Unilateral':    'Dumbbell_One-Arm_Triceps_Extension',
  'Tríceps Coice com Haltere':                     'Tricep_Dumbbell_Kickback',
  'Dip em Barras Paralelas':                       'Parallel_Bar_Dip',
  'Dip em Cadeira':                                'Bench_Dips',

  // ─── Core / Abdômen ─────────────────────────────────────────────────────────
  'Prancha Isométrica':                            'Plank',
  'Crunch Abdominal':                              'Crunches',
  'Abdominal Infra (Elevação de Pernas)':          'Flat_Bench_Lying_Leg_Raise',
  'Oblíquo com Rotação':                           'Oblique_Crunches',
  'Prancha Lateral':                               'Push_Up_to_Side_Plank',
  'Crunch com Cabo':                               'Cable_Crunch',
  'Abdominal Bicicleta':                           'Cross-Body_Crunch',
  'Leg Raise Deitado':                             'Flat_Bench_Lying_Leg_Raise',
  'Dead Bug':                                      'Dead_Bug',
  'Hollow Body Hold':                              'Plank',
  'Prancha com Toque no Ombro':                    'Plank',
  'Prancha com Elevação de Quadril (Pike)':        'Push_Up_to_Side_Plank',
  'Escalador com Torção':                          'Mountain_Climbers',

  // ─── Flexões (Push-Up variations) ───────────────────────────────────────────
  'Flexão Diamante':                               'Incline_Push-Up_Close-Grip',
  'Flexão Inclinada (Declinada)':                  'Decline_Push-Up',
  'Flexão de Braço Larga':                         'Incline_Push-Up_Wide',
  'Flexão de Braço Fechada':                       'Incline_Push-Up_Close-Grip',
  'Pike Push-Up':                                  'Incline_Push-Up',
  'One-Arm Push-Up':                               'One-Arm_Flat_Bench_Press',
  'Handstand Push-Up':                             'Handstand_Push-Ups',
  'Handstand Hold (Parada de Mão)':                'Handstand_Push-Ups',
  'Tempo Push-Up (Flexão Lenta)':                  'Clock_Push-Up',
  'Staggered Push-Up (Flexão Assimétrica)':        'Clock_Push-Up',

  // ─── HIIT / Cardio ───────────────────────────────────────────────────────────
  'Mountain Climber':                              'Mountain_Climbers',
  'Jumping Jacks':                                 'Freehand_Jump_Squat',
  'Polichinelo (Jumping Jack)':                    'Freehand_Jump_Squat',
  'Esteira (HIIT)':                                'Running_Treadmill',
  'Bicicleta Ergométrica':                         'Elliptical_Trainer',
  'Elíptico':                                      'Elliptical_Trainer',
  'Corrida Elevada no Lugar':                      'Running_Treadmill',
  'Sprint Curto (Tiro)':                           'Running_Treadmill',
  'Pular Corda':                                   'Battling_Ropes',
  'Lateral Shuffle':                               'Side_Leg_Raises',
  'Swing Lateral com Elástico':                    'External_Rotation_with_Band',

  // ─── Funcional / Olímpico ────────────────────────────────────────────────────
  'Inchworm':                                      'Inchworm',
  'World Greatest Stretch':                        'Worlds_Greatest_Stretch',
  'Power Clean':                                   'Power_Clean',
  'Clean and Press':                               'Clean_and_Press',
  'Muscle-Up':                                     'Muscle_Up',
  'Band Pull-Apart':                               'Band_Pull_Apart',
  'Bear Crawl':                                    'Bear_Crawl_Sled_Drags',
  'Kettlebell Swing':                              'One-Arm_Kettlebell_Swings',
  'Snatch com Haltere':                            'Dumbbell_Snatch',
  'L-Sit':                                         'Plank',
  'Front Lever':                                   'Hanging_Leg_Raise',
  'Skin the Cat':                                  'Muscle_Up',
  'Superman (Extensão Dorsal no Chão)':            'Hyperextensions_With_No_Hyperextension_Bench',
  'Superman com Alternância':                      'Hyperextensions_With_No_Hyperextension_Bench',

  // ─── Hiperextensão / Lombar ─────────────────────────────────────────────────
  'Hiperextensão Lombar':                          'Hyperextensions_Back_Extensions',

  // ─── Mobilidade / Alongamento ────────────────────────────────────────────────
  'Hip 90/90 (Mobilidade de Quadril)':             'Kneeling_Hip_Flexor',
  'Rotação Torácica':                              'External_Rotation',
  'Leg Swing (Balanço de Perna)':                  'Chair_Leg_Extended_Stretch',
  'Ankle Mobility Drill':                          'Standing_Hip_Flexors',
  'Pigeon Pose (Pombo — Quadril)':                 'Kneeling_Hip_Flexor',
  'Chest Stretch (Alongamento de Peitoral)':       'Chin_To_Chest_Stretch',
  'Alongamento de Isquiotibiais (Faixa)':          'Chair_Leg_Extended_Stretch',
  'Skipping (Corrida no Lugar)':                   'Running_Treadmill',
};

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  let content = fs.readFileSync(SEED_PATH, 'utf8');
  const lines = content.split('\n');
  let applied = 0;
  let skipped = 0;

  for (const [ptName, freeDbId] of Object.entries(CURATED)) {
    const escapedName = ptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`([ \\t]+name:\\s+'${escapedName}',)`, 'g');

    let match: RegExpExecArray | null;
    let found = false;
    while ((match = nameRegex.exec(content)) !== null) {
      const ahead = content.slice(match.index, match.index + 300);
      if (ahead.includes('freeDbId:')) { skipped++; found = true; break; }

      const nameLine = match[0];
      const indent = nameLine.match(/^([ \t]+)/)?.[1] ?? '    ';
      const insertion = `\n${indent}freeDbId: '${freeDbId}',`;

      content = content.slice(0, match.index + nameLine.length) + insertion + content.slice(match.index + nameLine.length);
      applied++;
      found = true;
      break;
    }

    if (!found) {
      // Exercise name not found in file at all — probably different wording
      // Just skip silently
    }
  }

  fs.writeFileSync(SEED_PATH, content);
  console.log(`✅ Aplicados: ${applied}  |  Já tinham freeDbId (skip): ${skipped}`);
  console.log(`📝 Seed atualizado em: ${SEED_PATH}`);
}

main();
