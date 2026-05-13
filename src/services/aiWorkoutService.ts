import OpenAI from 'openai';

export type GeneratedExercise = {
  name: string;
  sets: string;
  reps: string;
  rest: string;
};

export type GeneratedWorkout = {
  title: string;
  weekPreset: string;
  exercises: GeneratedExercise[];
};

const SYSTEM_PROMPT = `Você é um personal trainer especialista em prescrição de treinos.
Dado um prompt do usuário e uma lista de exercícios disponíveis no catálogo,
gere uma ficha de treino estruturada EXCLUSIVAMENTE em JSON válido com este schema:
{
  "title": string,
  "weekPreset": "semana_util" | "4" | "5" | "6",
  "exercises": [{ "name": string, "sets": string, "reps": string, "rest": string }]
}
Regras:
- Use preferencialmente exercícios do catálogo fornecido (match pelo nome).
- Máximo 12 exercícios por ficha.
- sets: número (ex: "4"), reps: intervalo (ex: "10-12"), rest: com unidade (ex: "60s").
- weekPreset deve refletir a frequência solicitada ("semana_util" = 5 dias).
- Retorne SOMENTE o JSON, sem markdown, sem texto extra.`;

export async function generateWorkoutFromPrompt(
  prompt: string,
  catalogNames: string[]
): Promise<GeneratedWorkout> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const catalogSection =
    catalogNames.length > 0
      ? `Catálogo disponível (use estes nomes preferencialmente):\n${catalogNames.join(', ')}\n\n`
      : '';

  const completion = await client.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    max_tokens: 700,
    temperature: 0.4,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${catalogSection}Solicitação: ${prompt}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';

  let parsed: GeneratedWorkout;
  try {
    parsed = JSON.parse(raw) as GeneratedWorkout;
  } catch {
    throw new Error('Resposta da IA inválida. Tente novamente com um prompt mais específico.');
  }

  if (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) {
    throw new Error('A IA não retornou exercícios. Tente reformular o prompt.');
  }

  return parsed;
}
