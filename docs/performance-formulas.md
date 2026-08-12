# Fórmulas do módulo Performance

Documento de referência das fórmulas do módulo Performance (Spec 033) e do seu
histórico de versões.

Fonte da verdade dos valores: [`src/modules/performance/performance.constants.ts`](../src/modules/performance/performance.constants.ts).
Nenhum engine hardcoda peso ou limiar — tudo entra por lá.

## Como o versionamento funciona

Toda linha derivada por fórmula carrega a coluna `formula_version`:
`workout_session_metrics`, `user_pr_events` e `user_performance_snapshots`.

Ao mudar qualquer constante ou fórmula:

1. incremente `FORMULA_VERSION` em `performance.constants.ts`;
2. adicione uma entrada no changelog no fim deste arquivo (o que mudou, por quê,
   e se houve recomputo);
3. decida sobre recomputo, caso a caso:
   - **`workout_session_metrics` e `user_pr_events` podem ser recomputados** —
     são 100% deriváveis de `workout_sessions` + `workout_set_logs`, que não
     mudam. O procedimento é `DELETE FROM <tabela> WHERE formula_version < N`
     seguido de reexecução do backfill da migration 1823.
   - **`user_performance_snapshots` NÃO é recomputado.** Um snapshot é a
     fotografia do que o aluno viu naquele dia. Reescrevê-lo com a fórmula nova
     falsificaria o histórico — o gráfico passaria a mostrar uma evolução que
     nunca foi exibida a ninguém.

---

## v1 — Onda P1 (ago/2026)

### Tonelagem (carga externa)

```
tonnage_kg = Σ (reps_done × load_done_kg)   [séries com status 'done']
```

`NULL` quando nenhuma série teve carga registrada. Treino de peso corporal não
tem tonelagem — e `NULL` diz isso, enquanto `0` diria "levantou nada".

### Carga interna (`effort_load`)

Conceito sRPE de Foster: o custo da sessão para o aluno, que existe mesmo sem
carga externa.

```
srpe = session_rpe  ou, na ausência dele,  round(média dos rpe das séries 'done')

effort_load = srpe × duration_min                     → método 'srpe_duration'
            | srpe × sets_done × 4                    → método 'srpe_sets'
            | NULL                                     (quando não há srpe algum)
```

O método usado fica gravado em `effort_load_method`, para dar para medir depois
quanto do dado é estimado e quanto é medido.

**Por que o fallback é a regra hoje:** o cliente registra a sessão inteira ao
final, então `started_at = ended_at` e a duração real é desconhecida. Enquanto
não existir um "iniciar treino" de verdade, `duration_min` é `NULL` e todo
`effort_load` sai por `srpe_sets`. Os 4 minutos por série são um proxy declarado
(execução + descanso típicos de musculação), não uma medição.

**Por que não reusar o `calcEstimatedLoad` do Fight Intelligence:** implementa o
mesmo conceito para outro domínio, com escala própria (0–100, com fator por tipo
de treino) e tabela própria (`athlete_post_workout_checkin`). Unificar exigiria
mudar a escala de um dos dois e invalidar o histórico já gravado do outro.

### Duração medida (`duration_min`)

```
NULL                             se retroativa, ou sem ended_at, ou < 60s de intervalo
clamp(round(segundos/60), 5, 240)  caso contrário
```

Abaixo de 60 segundos não é sessão curta, é ausência de medição. O teto de 240
corta a sessão esquecida aberta.

### Estimativa de 1RM (Epley)

```
e1rm = load_kg × (1 + reps/30),  arredondado a 0,5 kg
       calculado somente para 1 ≤ reps ≤ 12 e load_kg > 0
```

Acima de 12 repetições qualquer fórmula de 1RM extrapola demais; devolvemos
`NULL` em vez de um número inventado. A série continua contando para tonelagem e
para recorde de repetições.

Epley em vez de Brzycki: mais estável na faixa de 6 a 12 repetições — onde a
musculação de academia vive — e mais simples de explicar ao aluno.

### Recordes (`user_pr_events`)

Quatro categorias, todas por `(usuário, exercício)`:

| categoria | valor | observação |
|---|---|---|
| `max_load` | maior `load_done_kg` de uma série `done` | |
| `best_e1rm` | maior e1RM da sessão | usa a fórmula acima |
| `session_volume` | maior `Σ reps × kg` do exercício numa sessão | |
| `max_reps` | maior `reps_done` | **só séries sem carga** (peso corporal) |

Um evento só é gravado quando o valor **supera** o melhor anterior, o que torna
a série monotônica e a tupla `(user, exercise, kind, value)` única por
construção — encodada como constraint no banco.

O primeiro registro de cada `(exercício, categoria)` recebe `is_first = true`:
é estreia, não recorde. Não celebra e não pontua no Progress Score.

**Sequência de treinos não é categoria de PR** — já existe em
`user_gamification_stats.current_streak` e é reutilizada de lá.

> ⚠️ **Dependência para a Onda P2 — leia antes de implementar a detecção online.**
>
> Na P1 o ledger é preenchido UMA vez, pelo backfill da migration 1823, e nada
> mais escreve nele. Toda sessão registrada entre o deploy da P1 e o da P2 fica
> de fora.
>
> Se a detecção online da P2 subir lendo "melhor atual" direto de
> `user_pr_events`, ela vai comparar contra um recorde defasado: a primeira
> sessão que superar o valor ANTIGO (sem superar o real, que está em
> `workout_set_logs`) emitirá um PR falso, com `previous_value` errado.
>
> **O primeiro passo da P2 é reexecutar o backfill** (o `INSERT ... SELECT` da
> 1823 é idempotente e pode rodar em tabela populada — a constraint
> `uq_pr_events_user_exercise_kind_value` absorve o que já existe).

#### Recorde de exercício excluído

`exercise_id` é nullable com `ON DELETE SET NULL`: apagar um exercício do catálogo
**não** apaga o recorde do aluno, só desfaz o vínculo. `exercise_name` é `NOT NULL` e
guarda o contexto histórico.

Regras de leitura que valem para toda onda futura (travadas por teste de integração):

| regra | por quê |
|---|---|
| `LEFT JOIN exercises`, nunca `INNER JOIN` | um join obrigatório faria sumir exatamente os recordes órfãos |
| rótulo vem de `user_pr_events.exercise_name` | `exercises.name` é NULL para o órfão |
| agrupar por `(exercise_id, exercise_name)` | só por `exercise_id`, dois exercícios excluídos diferentes se fundiriam sob o mesmo NULL |
| detecção online busca por `exercise_id = ANY(...)` | linhas órfãs não casam, então não contaminam recordes de exercícios vivos |

O índice único `(user_id, exercise_id, kind, value)` deixa de cobrir as linhas órfãs
porque `NULL ≠ NULL` no Postgres. É o comportamento desejado: a constraint protege a
idempotência **enquanto o exercício vive**, que é quando alguém escreve. Depois, o ledger
apenas repousa.

### Consistência de frequência

```
activeDays28 = COUNT(DISTINCT dia_no_fuso_do_aluno) sobre a UNIÃO de:
                 user_workout_logs.completed_at
                 workout_sessions.performed_at   (status completed | partial)
                 personal_session_logs.session_at (status present | partial)

target       = round(treinos_por_semana_da_ficha_ATIVA × 4)  [janela de 28d = 4 semanas]
               ajustado proporcionalmente quando o aluno está sob prescrição há
               menos de 28 dias, com piso de janela de 7 dias

consistencyPct = clamp(round(activeDays28 / target × 100), 0, 100)
                 NULL quando não há ficha ativa (sem denominador)
```

As três fontes são obrigatórias: contar só as duas primeiras faria o aluno
acompanhado presencialmente parecer ausente. É a mesma união que o dashboard do
personal já usa desde a Spec 009 — divergir criaria dois "dias ativos"
diferentes no mesmo produto.

O dia é sempre o do **aluno** (`APP_TIMEZONE`), nunca o do servidor: um treino às
22h de Brasília pertence ao dia em que aconteceu para quem treinou.

**O preset vem da ficha ativa; a "idade" vem da PRIMEIRA ficha que o aluno já
teve.** As duas coisas saem de linhas diferentes de propósito. Cada revisão de
ficha cria uma linha nova em `personal_workout_plans`; se a idade viesse dessa
linha, o denominador encolheria a cada revisão enquanto o numerador continua
varrendo 28 dias, e a consistência saltaria para 100% no dia em que o personal
revisou a ficha — sem o aluno ter mudado nada. Revisar ficha é exatamente o que
o produto pede que o personal faça com frequência.

> **Não confundir com aderência.** `adherencePct` (Spec 010) mede *séries feitas
> ÷ séries prescritas* e se chama **"Aderência às séries"**. `consistencyPct`
> mede *dias ativos ÷ dias prescritos* e se chama **"Consistência de
> frequência"**. São números diferentes com nomes diferentes — um QA anterior
> encontrou os dois exibidos sob o mesmo rótulo, e ninguém sabia qual era qual.

### Progress Score

Não existe na v1. Chega na Onda P3, com o breakdown de fatores obrigatório —
a tabela `user_performance_snapshots` já tem o CHECK que impede gravar score sem
pelo menos um fator.

---

## Changelog

| versão | data | mudança |
|---|---|---|
| 1 | ago/2026 | Versão inicial (Spec 033, Onda P1): tonelagem, carga interna sRPE, duração, e1RM Epley, recordes e consistência de frequência. |
