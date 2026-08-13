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

---

## v1 — Onda P3 (ago/2026)

A P3 não mudou nenhuma fórmula da P1: acrescentou duas leituras que consomem o
que a P1 já materializa. `FORMULA_VERSION` continua **1** de propósito — nada do
que a P1 gravou precisou ser recomputado.

### Ritmo de carga

Compara a **média diária** de `effort_load` das duas janelas:

```
media7  = Σ effort_load dos últimos 7 dias  ÷ 7
media28 = Σ effort_load dos últimos 28 dias ÷ 28
ratio   = media7 ÷ media28
```

Média diária, e não soma: 7 dias contra 28 somados dariam sempre ~0,25 e a razão
não significaria nada. Dividindo cada soma pelos seus dias, a razão fica em torno
de 1 quando o ritmo é o mesmo.

| condição | faixa exibida |
|---|---|
| `ratio ≥ 1.6` | Bem acima do seu ritmo habitual |
| `1.3 ≤ ratio < 1.6` | Acima do seu ritmo habitual |
| `0.8 ≤ ratio < 1.3` | Dentro do seu ritmo habitual |
| `ratio < 0.8` | Abaixo do seu ritmo habitual |

**A razão crua nunca sai na API.** Ela é parente do ACWR, usado em preparação
física para falar de risco de lesão, e os dados aqui não sustentam afirmação
clínica: a duração da sessão quase nunca é medida, então a maior parte da carga
vem do fallback por séries. A faixa comunica o que é honesto dizer.

Exige **≥ 8 sessões com `effort_load`** em 28 dias; abaixo disso, e quando
`media28 = 0`, a faixa é `null` e a tela não mostra nada. O único consumidor do
número cru é o Readiness, que acende o fator `load.spike` no mesmo limiar da
faixa de pico (`ratio ≥ 1.6`) — um limiar só, para que a tela de prontidão e a
de evolução nunca discordem sobre o que é pico.

### Progress Score

```
score = clamp(50 + Σ deltas dos fatores, 0, 100)
```

Janela: **últimos 28 dias vs. os 28 anteriores**. Comparação sempre do aluno com
ele mesmo — nunca com outros alunos.

**Por que somar deltas a partir de 50**, e não fazer média ponderada de
componentes normalizados: a média obriga a inventar um valor quando um
componente falta, e falta é o caso comum (treino de peso corporal não tem
tonelagem; aluno sem ficha não tem consistência). Somando deltas, componente
ausente contribui **zero** e o score fica onde estava — a ausência de informação
não vira informação.

| fator | dispara quando | delta |
|---|---|---|
| `progression.load` | exercícios comparáveis melhoraram | `round(melhoraram ÷ total × 18)`, 0..+18 |
| `progression.regression` | ≥ 40% dos comparáveis pioraram | −12 |
| `consistency.high` | `consistencyPct ≥ 85` | +14 |
| `consistency.low` | `consistencyPct < 40` | −10 |
| `volume.trend` | tonelagem nas duas janelas, anterior > 0 | `round(clamp(variação ÷ 0.30, −1, 1) × 8)`, −8..+8 |
| `pr.recent` | ≥ 1 recorde real na janela | +6 (fixo) |
| `goal.achieved` | metas atingidas (Onda P4) | +6 |
| `inactivity` | > 14 dias sem sessão | −20 |

Detalhes que mudam o número:

- **Exercício comparável** = tem ≥ 2 pontos em **cada** janela. Exercício estreado
  este mês não entra — contá-lo como "não melhorou" puniria quem variou o treino.
- **Recorde tem peso fixo**, não proporcional: dez recordes num dia de teste de
  força não valem dez vezes um.
- **Volume exige tonelagem nas duas janelas.** Treino de peso corporal tem
  tonelagem *nula* (não zero); comparar contra ausência produziria uma queda de
  100% que não aconteceu.
- **`consistencyPct = null`** (aluno sem ficha) desliga o fator nos dois
  sentidos. Sem prescrição não há o que cobrar.
- Todo delta é **inteiro** (`Math.round` no fator, não no total), então a soma
  reproduz o score exibido somando a tabela à mão.

#### Exemplo reproduzível

O fixture do teste de integração (`performance-p3.integration.test.ts`) tem 3
exercícios comparáveis, todos em melhora, tonelagem 4260 → 4820 kg e 1 recorde:

```
progression.load = round(3/3 × 18)                        = +18
volume.trend     = round(clamp(0.1315/0.30, -1, 1) × 8)   =  +4
pr.recent                                                 =  +6
score = clamp(50 + 18 + 4 + 6, 0, 100)                    =  78
```

#### Onboarding

`value = null` e `status = 'onboarding'` quando a conta tem **< 28 dias** OU
houve **< 6 sessões nos últimos 60 dias**. A tela mostra "Calibrando" — nunca
zero. Zero seria uma afirmação; a ausência de número é a verdade.

#### Fallback obrigatório

Quando nenhum fator dispara, o engine emite o fator `steady` ("Sem mudança
relevante no período") com delta 0. Não é enfeite: o CHECK de
`user_performance_snapshots` recusa score gravado sem pelo menos um fator, e a
regra de produto é que nenhum número apareça sem explicação.

#### "O que mudou na semana"

`compareFactorWindows(hoje, 7 dias atrás)` compara os **breakdowns**, não os
números — a diferença dos scores diz que mudou, não o quê. Fator que
desapareceu entra com o delta invertido (um `inactivity` que sumiu é boa
notícia). Nenhuma dessas frases passa por LLM: todas saem de fator existente.

#### Snapshot

Um por `(user_id, snapshot_date)`, calculado no primeiro GET do dia e reusado
depois. Invalidado junto do metabolismo em `invalidateAfterCheckin`. Snapshots
antigos **nunca** são recomputados: são fotografias do que se sabia naquele dia.

---

## v1 — Onda P4 (ago/2026)

Metas não introduzem métrica nova: cada tipo LÊ uma medida que já existia. É
proposital — se a meta medisse por conta própria, o produto teria dois números
com o mesmo nome, que é exatamente o defeito encontrado entre "aderência" e
"consistência" num QA anterior.

### De onde vem cada medição

| tipo | o que mede | fonte |
|---|---|---|
| `exercise_load` | maior carga em uma série | `user_pr_events` (`max_load`) |
| `exercise_e1rm` | melhor 1RM estimado | `user_pr_events` (`best_e1rm`) |
| `exercise_reps_at_load` | mais repetições em séries com carga ≥ alvo | `workout_set_logs` |
| `weekly_frequency` | dias ativos na semana ISO corrente | UNION das 3 fontes |
| `monthly_frequency` | dias ativos no mês de calendário | UNION das 3 fontes |
| `streak` | sequência corrente | `user_gamification_stats` |

A UNION é a mesma da aba Consistência (`user_workout_logs` ∪ `workout_sessions`
∪ `personal_session_logs`): um dia registrado só pelo personal conta para a meta
tanto quanto conta no calendário.

**Volume e Progress Score não viraram tipos de meta** — não estão previstos na
Spec 033. Volume ainda por cima não é comparável entre exercícios, e uma meta de
score seria uma meta sobre um número que já é resumo de outros.

### Baseline

Medido pelo servidor **na criação**, com a MESMA função que medirá o progresso
depois. Dois caminhos diferentes para o mesmo número fariam a meta nascer com
progresso não-zero por diferença de método.

Nunca é digitado pelo aluno. Quando não há medição (exercício nunca treinado), o
baseline é `NULL` — não zero. `NULL` significa "não sabemos ainda"; zero seria a
afirmação de que ele levanta zero.

### Progresso

```
observado = monotônica ? max(best_value, medição atual) : medição atual
de        = baseline ?? 0
progresso = clamp((observado − de) ÷ (alvo − de), 0, 1)
```

Medir a partir do baseline, e não de zero: quem sai de 90 kg rumo a 100 já teria
90% de barra na fórmula ingênua, antes de levantar nada de novo.

Bordas, todas com teste: `alvo = baseline` e `alvo < baseline` devolvem resposta
binária em vez de dividir por zero; ausência de medição devolve `null`, nunca 0;
`NaN` e `Infinity` na entrada saem como `null`. **Nenhum desses valores chega à
API.**

### Monotônicas × cíclicas

| tipo | referência | por quê |
|---|---|---|
| `exercise_load`, `exercise_e1rm`, `exercise_reps_at_load`, `streak` | `best_value` | quem levantou 95 kg não "desaprendeu" ao treinar leve na semana seguinte |
| `weekly_frequency`, `monthly_frequency` | valor do período | a semana ZERA na segunda; guardar o melhor mostraria 4/4 para sempre |

A **conclusão** é monotônica nos dois casos: cumprir a semana de 4 treinos é um
fato, e a semana seguinte não o desfaz.

### Meta de dois alvos

`exercise_reps_at_load` ("30 kg × 12 reps") é o único tipo com dois números. A
**carga é filtro**, as **repetições são o eixo** do progresso. Por isso 35 kg × 8
não cumpre a meta, ainda que o e1RM seja superior: a meta pedia repetições
naquela carga.

### Ciclo de vida

`active` → `achieved` | `abandoned` | `expired`. Estado final é final: meta
concluída não volta a ativa porque a performance caiu depois, e meta abandonada
não ressuscita sozinha.

- **Conclusão** é avaliada **depois do COMMIT** da sessão — antes disso as
  séries e os recordes que ela lê ainda não existem para outra conexão.
- **Idempotência**: `UPDATE ... WHERE status = 'active'`. Reprocessar encontra a
  meta já concluída, não atualiza linha e não repete evento.
- **Concorrência**: `pg_advisory_xact_lock(2, user_id)` serializa a avaliação do
  mesmo aluno; duas sessões simultâneas produzem uma conclusão só.
- **Expiração** é lazy, na leitura, com `due_on < hoje` — a meta que vence hoje
  vale o dia inteiro. Sem cron.

### Meta que já nasceria cumprida

Recusada (`422 GOAL_ALREADY_MET`). Uma meta criada abaixo do melhor atual é um
troféu retroativo que ninguém perseguiu.

### Versionamento

`metric_version` é gravado em cada meta (hoje `1`). Uma mudança futura de fórmula
não pode reinterpretar em silêncio uma meta antiga.

---

## v1 — Onda P5 (ago/2026)

A P5 não introduz fórmula: ela LÊ o que as ondas anteriores calculam e acrescenta
uma camada de leitura para o personal. `FORMULA_VERSION` continua **1**.

### Rótulo canônico da meta

`goalDisplayLabel(goal)` (em `goals.engine.ts`) é a única fonte do texto de uma
meta. É **derivado, nunca persistido**: guardar a frase criaria uma segunda
verdade que envelhece a cada renomeação de exercício. Aluno, personal e o resumo
escrito consomem o mesmo campo `displayLabel` — na P4 esse texto era montado no
frontend do aluno, e três cópias divergiriam no primeiro ajuste de redação.

### Sinais determinísticos

Regras em `insights.engine.ts`, limiares em `SIGNAL_RULES`. Cada sinal carrega
`evidence` com os números que o dispararam — sem isso é opinião com aparência de
dado.

| tipo | regra | janela | severidade |
|---|---|---|---|
| `GOAL_ACHIEVED` | meta concluída na janela | 28 dias | positive |
| `RECENT_PR` | ≥ 1 recorde real (não estreia) | 28 dias | positive |
| `PROGRESSION_POSITIVE` | ≥ 2 exercícios comparáveis e ≥ 50% melhorando | 28d vs 28d | positive |
| `SCORE_UP` / `SCORE_DOWN` | \|Δ score\| ≥ 5 vs. 28 dias atrás | 4 semanas | positive / attention |
| `CONSISTENCY_DOWN` | semana anterior ≥ 3 dias E queda ≥ 2 | semana | attention |
| `PROGRESSION_STALLED` | ≥ 56 dias sem recorde **E** ≥ 8 sessões no período | 56 dias | attention |
| `GOAL_NEAR_COMPLETION` | meta ativa com progresso ≥ 80% e < 100% | agora | neutral |
| `LOAD_UP` | faixa `above` (neutral) ou `spike` (attention) | 7d vs 28d | neutral / attention |
| `LOAD_DOWN` | faixa `below` | 7d vs 28d | neutral |

Detalhes que separam sinal de ruído:

- **Estagnação exige treino acontecendo.** Sem a segunda condição, "parou de
  evoluir" seria dito a quem parou de treinar — e mandaria o personal mexer no
  programa quando o problema é presença.
- **Queda de frequência exige uma base de onde cair** (semana anterior ≥ 3). Sair
  de 2 para 0 é ausência de rotina, não queda de rotina; o motor de risco do
  dashboard já cobre esse caso.
- **Severidade tem três níveis** — `positive`, `neutral`, `attention`. Não existe
  "crítico": vocabulário de emergência aplicado a uma semana com dois treinos
  ensina o personal a ignorar o alerta quando algo importar de verdade.
- **Nada de linguagem clínica**, e há teste que varre as descrições procurando por
  ela.

### Priorização

1. Sinais que EXPLICAM outros suprimem o resumo: `SCORE_UP` sai quando
   `PROGRESSION_POSITIVE`, `RECENT_PR` ou `GOAL_ACHIEVED` estão presentes;
   `SCORE_DOWN` sai quando `CONSISTENCY_DOWN` ou `PROGRESSION_STALLED` estão.
   Fica a informação mais específica, que é a acionável.
2. Ordenação: `positive` → `attention` → `neutral`, com desempate por uma tabela
   fixa de tipos — nada depende da ordem devolvida pelo SQL.
3. Teto de **5** cartões.

### Snapshot e síntese

`GET /personal/students/:id/performance` devolve três blocos que não se misturam:
`facts` (calculado), `signals` (determinístico) e o espaço da síntese. O texto em
linguagem natural vem de outro endpoint e diz em `source` se foi escrito por IA
ou montado a partir dos próprios dados.

`snapshotHash` identifica o SIGNIFICADO dos fatos e é a chave do cache da
síntese. `generatedAt` fica de fora do hash de propósito: incluí-lo faria o hash
mudar a cada chamada, e o cache nunca acertaria.

---

## v1 — Onda P6 (ago/2026)

A P6 não criou motor: readiness, check-in e adaptação já existiam. Ela conectou,
travou e versionou o que estava solto.

### Readiness continua QUALITATIVO

`green | yellow | red`, exibido como **Pronto / Moderado / Recuperação**. Não há
score 0–100, e a ausência é decisão registrada: a Spec 033 coloca "readiness
numérico geral" no anti-escopo, porque um número aqui sugeriria medição
fisiológica que este produto não faz. O 0–100 do Fight Intelligence segue
escopado a esporte, em motor separado.

`READINESS_VERSION = 1`, independente de `FORMULA_VERSION` (Progress Score) e de
`ADAPTATION_VERSION`. Três conceitos, três versões: amarrá-las faria a mudança
de um obrigar a reinterpretar o histórico dos outros.

### O fator de carga que estava morto

A P3 criou o campo opcional `trainingLoadRatio` e o gatilho `load.spike`
(`ratio ≥ 1.6`), mas **nada nunca alimentou o campo**: o fator era código morto,
e o teste de regressão daquela onda ("sem o campo, saída idêntica") passava
justamente porque o campo nunca chegava.

A P6 fecha o circuito — `readiness.service.ts` lê `loadScoreAggregates` e passa
a razão ao Lens. Falha na consulta devolve `null` e o fator não participa:
prontidão não deixa de existir porque uma leitura de carga falhou.

No mesmo passo, os dois pontos que montavam o input do Lens (um com cache, outro
sem) viraram **um só**. Eram cópias, e a cópia divergiria no instante em que a
P6 acrescentasse o ritmo de carga a um dos lados — dois estados diferentes para
o mesmo aluno, dependendo de qual ramo executou.

### Estados e evidência

| estado | nível | quando |
|---|---|---|
| Pronto | `green` | nenhum fator de atenção ou bloqueio |
| Moderado | `yellow` | sono ruim, cansaço, carga mental alta, queda metabólica, nutrição ruim, **pico de carga** |
| Recuperação | `red` | dor relatada, metabolismo muito baixo, queda acentuada, ou cansaço **somado a** noite mal dormida |

Cada leitura carrega `factors[]` com `id`, `label` e `severity`. `confidence`
(`high`/`medium`/`low`) mede **cobertura de dado**, nunca probabilidade clínica.

Sem check-in do dia o endpoint devolve `insufficient_data` — e não "verde" por
omissão. Afirmar que alguém está pronto sem ter perguntado nada é o jeito mais
barato de perder a confiança de quem não estava.

### Adaptação: números que agora têm nome

| | amarelo | vermelho |
|---|---|---|
| séries | −1 | −2 |
| descanso | ×1,15 | ×1,30 |
| RPE | −1 | piso da política |
| técnica avançada | rebaixada | rebaixada |
| sugestão de recuperação | — | sim |

Estavam escritos direto no laço (`isRed ? 2 : 1`), sem teste algum. Agora vivem
em `ADAPTATION_RULES_V1` e cada número tem asserção. Sobre eles ainda incidem os
tetos que o personal controla (`maxSetReductionPct`, `maxRestIncreasePct`,
`minIntensityPct`).

**Achado da onda:** com o teto padrão de séries (25%), o piso
`ceil(sets × 0,75)` engole a redução extra do vermelho em exercícios de 3 a 6
séries — vermelho e amarelo reduzem igual, e a diferença de volume só aparece a
partir de 7. Não é defeito (o teto faz o que promete), mas significa que o que
separa os dois estados na prática é descanso, RPE e a sugestão de recuperação.

Toda adaptação só REDUZ exigência ou AUMENTA recuperação. `assertSafeAdaptation`
recusa mais séries, RPE maior, descanso menor ou troca de exercício — substituir
exercício seria prescrever, e quem prescreve tem registro.

### Idempotência: a garantia está em quem chama

O motor é função pura e não sabe se o que recebeu já foi adaptado — encadear
compõe desconto (4 → 3 → 2 séries). A proteção é que `GET /training/today`
adapta **sempre a partir de `day.items`**, carregado fresco da prescrição do
personal. Há teste para as duas metades: partir do original é estável, e
encadear compõe.

O original nunca é sobrescrito: fica em `workout_adaptation_log.original_payload`
(o upsert do dia não o reescreve) e viaja ao cliente em `originalPlanDay`.

### Override do aluno

O ajuste é sugestão, não tutela: o aluno pode seguir a prescrição original, e a
escolha é reversível e do dia — não vira preferência permanente. Ambas as
escolhas são medidas (`training.adaptation.accepted` / `.declined`); instrumentar
só uma delas seria viés embutido.

---

## Changelog

| versão | data | mudança |
|---|---|---|
| 1 | ago/2026 | Versão inicial (Spec 033, Onda P1): tonelagem, carga interna sRPE, duração, e1RM Epley, recordes e consistência de frequência. |
| 1 | ago/2026 | Onda P3 (Spec 033): ritmo de carga (faixa qualitativa) e Progress Score. Nenhuma fórmula da P1 mudou — versão mantida em 1, sem recomputo. |
| 1 | ago/2026 | Onda P4 (Spec 033): metas. Nenhuma métrica nova — cada tipo lê medida existente. Versão mantida em 1, sem recomputo. |
| 1 | ago/2026 | Onda P5 (Spec 033): visão do personal. Rótulo canônico da meta, sinais determinísticos e síntese opcional. Nenhuma fórmula nova; versão mantida em 1. |
| 1 | ago/2026 | Onda P6: readiness ganha o ritmo de carga (fator `load.spike` deixa de ser código morto), constantes de adaptação nomeadas, `READINESS_VERSION` e `ADAPTATION_VERSION` próprias. Nenhuma fórmula de performance mudou. |
