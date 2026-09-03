# Curadoria da Biblioteca de Exercícios — 2026Q3

Curadoria de conteúdo (dados, não schema) da biblioteca de exercícios S2CORE, pedida item a
item pelo usuário. Executada via
[`src/scripts/curationExerciseLibraryFixes2026Q3.ts`](../../src/scripts/curationExerciseLibraryFixes2026Q3.ts)
(idempotente, reexecutável) + edições diretas nos arquivos de seed
(`src/seeds/exercisesLibrary.seed.ts`, `src/seeds/commonGymExerciseCoverage.seed.ts`,
`src/seeds/gifDoTreino.map.ts`).

**Contagem final: 41 itens DONE, 20 BLOCKED, 6 "já existia / nenhuma ação necessária" (a
premissa do pedido não se confirmou), distribuídos como no detalhamento abaixo.**

## Como isto foi verificado

- **Fonte de GIF**: o gifdotreino.com não tem busca pública, mas expõe (no próprio HTML/JS do
  site) o endpoint `search_gifs.php` que alimenta a busca da página — usado só para
  **descobrir** candidatos reais no catálogo deles (963 itens buscados e salvos localmente);
  **todo** candidato usado foi confirmado com `curl -I` retornando HTTP 200 antes de entrar no
  mapa, e os casos ambíguos foram abertos visualmente (baixados + primeiro/frame do meio
  extraído com Pillow) para confirmar que a execução mostrada bate com o nome do exercício —
  não só que a URL existe.
- **Banco local**: `docker compose` já estava de pé (porta 5433). Testado em DOIS estados: (1)
  banco criado do zero já com os seeds curados (`corefitdb_test`) e (2) banco criado a partir do
  seed ANTERIOR à curadoria via `git stash` temporário, depois com o script de curadoria rodado
  por cima (`corefitdb_test_pre`) — esse segundo caminho é o que realmente exercita o rename/
  archive por ID contra dado pré-existente (o primeiro só confirma "já aplicado", que também é
  testado). `DATABASE_URL` sempre explícito na linha de comando — nunca o `.env` do projeto.
- **Todas as 229 URLs finais do mapa** (`gifDoTreino.map.ts`) foram reverificadas em lote com
  HTTP 200 depois de todas as edições, não só as que eu mudei.

## 1. OMBROS

| Item | Status | Detalhe |
|---|---|---|
| Renomear "Band Pull-Apart" → "Elevação Lateral com Elástico" | **DONE** | Rename por ID. **Achado**: o gif antigo (band pull-apart / reverse-fly com elástico, deltoide posterior) não bate mais com o NOVO nome (elevação lateral, deltoide médio/lateral) — são movimentos biomecanicamente diferentes. Corrigido o gif junto: `Exercicios/Funcional e HIT/Adução de Ombro com Faixa Elástica.gif` (verificado visualmente — braço elevado lateralmente até a altura do ombro, deltoide destacado). |
| Renomear "Crucifixo Inverso (Elevação Posterior)" → "Crucifixo Inverso" + corrigir gif | **DONE** | Rename por ID. Gif antigo (`Voador invertido.gif`) mostrava uma MÁQUINA (pec-deck invertido) enquanto o exercício descreve halteres — inconsistência confirmada visualmente. Novo: `Exercicios/Mobilidade/Elevação lateral de deltóide posterior com halteres.gif` (halter, prono, deltoide posterior — bate com equipment='halteres' e as instruções). |
| "Elevação Frontal" vs "Elevação Frontal com Halteres" — mesmo gif | **DONE** | Confirmado: os dois usavam `Elevação frontal com halteres.gif`. Corrigido "Elevação Frontal" para `Exercicios/Ombros/Levantamento frontal com anilha.gif` (confirmado visualmente: anilha seguraba com as duas mãos, sem halteres). **Efeito colateral corrigido**: como o gif novo mostra anilha, `equipment` mudou de `'halteres'` para `'anilha'` e as `instructions` foram ajustadas — senão o campo ficaria mentindo sobre o equipamento mostrado no gif. |
| Duplicidade "Encolhimento com Barra" vs "Encolhimento de Ombros com Barra" | **DONE** | Mesmo `freeDbId`/gif confirmado. Mantido "Encolhimento de Ombros com Barra" (nome mais descritivo, já no seed principal); "Encolhimento com Barra" **arquivado** (`status='archived'`, nunca DELETE) e removido do seed satélite (comentário no lugar) para não ressuscitar no próximo reseed. |
| Verificar classificação de "posterior de ombro" | **DONE (nenhuma ação — já correto)** | "Crucifixo Inverso", "Face Pull no Cabo" e "Remada Alta no Cabo" já estão com `body_part='ombro'`, coerentemente. Nenhuma reclassificação necessária. |

## 2. BÍCEPS

| Item | Status | Detalhe |
|---|---|---|
| Corrigir gif "Rosca com Cabo (Cross Body)" | **BLOCKED** | Nenhum gif de "cross body cable curl" inequívoco encontrado no catálogo do gifdotreino (963 itens vasculhados) — o candidato mais próximo (`Rosca com cabo de um braço.gif`, já em uso) é uma rosca unilateral padrão, não claramente "cross body" (cruzando o corpo em direção ao ombro oposto). Trocar sem certeza visual seria arriscar substituir por algo igualmente impreciso. |
| Corrigir gif "Rosca Spider" | **BLOCKED** | Inspecionei visualmente as 2 variantes disponíveis (`Rosca spider com único haltere.gif`, em uso, e `Rosca spider unilateral.gif`) — ambas são execuções plausíveis de spider curl com halteres num banco 45°, nenhuma claramente "errada". Nosso exercício declara `equipment: 'barra'`, mas **nenhuma** variante de spider curl com barra apareceu no catálogo do gifdotreino — trocar entre as duas opções de halter não resolveria a divergência real (equipamento). Sem gif de barra verificado, mantive o atual. |
| Renomear "Rosca Scott (Preacher Curl)" → "Rosca Scott com Barra" | **DONE** | Rename por ID (chave do dicionário de aliases também sincronizada). |
| Adicionar "Rosca Inversa com Cabo" / "Rosca Inversa na Polia" | **DONE** | Tratados como o MESMO exercício (cabo = polia neste catálogo — ver "Rosca Direta na Polia", já `equipment: 'cabo'`) — cadastrado só **"Rosca Inversa na Polia"**, evitando duplicata. Gif: **BLOCKED** (nenhum reverse-cable-curl verificado no gifdotreino); usa fallback `freeDbId: 'Reverse_Cable_Curl'` (imagem estática do free-exercise-db). |
| Adicionar "Rosca Scott com Halter" | **DONE (já existia)** | Já cadastrado em `commonGymExerciseCoverage.seed.ts` com gif próprio (`Rosca scott com halteres.gif`). Nenhuma ação necessária. |
| Adicionar "Rosca Scott na Máquina Unilateral" | **DONE** | Novo, distinto do "Rosca Scott Máquina" (bilateral) já existente. Gif: **BLOCKED** (achei só a versão com halteres unilateral, não a de máquina/alavanca unilateral); fallback `freeDbId: 'Machine_Preacher_Curls'` (mesmo do Scott Máquina bilateral). |
| Adicionar "Rosca Simultânea com Halteres" | **DONE (já existia)** | Já cadastrado em `commonGymExerciseCoverage.seed.ts`. Sem gif do gifdotreino (não fazia parte do pedido de correção de mídia). |
| Adicionar "Rosca Unilateral com Halter" | **DONE** | Novo, gif verificado: `Exercicios/Bíceps/Rosca bíceps unilateral.gif` (confirmado visualmente: rosca em pé, um braço, o outro segurando o halter parado — bíceps destacado). |
| Adicionar "Bíceps Curl to Shoulder Press" | **DONE** | Nome PT-BR curado: **"Rosca Inversa com Desenvolvimento"** (rosca inversa seguida de desenvolvimento, sem pausa). Gif: **BLOCKED** (movimento composto pouco comum, não encontrado no gifdotreino nem no free-exercise-db) — cadastrado sem mídia (padrão já existente no catálogo para exercícios sem match). |

## 3. TRÍCEPS

| Item | Status | Detalhe |
|---|---|---|
| "Extensão de Tríceps Acima da Cabeça na Polia" → "Tríceps Francês na Polia" | **DONE** | Rename por ID. |
| "Extensão de Tríceps com Haltere Unilateral" → "Francês Unilateral com Halter" | **DONE** | Rename por ID (alias sincronizado). |
| "Fundinho (Bench Dip)" → "Dip no Banco" | **DONE** | Rename por ID (alias sincronizado). |
| "Mergulho na Máquina" → "Paralela na Máquina" | **DONE** | Rename por ID. |
| "Mergulho (Tríceps Dip)" → "Tríceps na Barra Paralela Livre" | **DONE** | Rename por ID. |
| "Tríceps Francês com Barra W em Pé" → "Tríceps Francês com Barra em Pé" + corrigir gif | **DONE** | Rename por ID. **Confirmado visualmente**: o gif antigo (`Extensão de tríceps com barra atrás da cabeça.gif`) era na verdade um **skull crusher DEITADO no banco** — nada "em pé". Novo gif verificado: `Exercicios/Tríceps/Extensão de tríceps com barra em pé.gif` (em pé, extensão acima da cabeça, confirmado por inspeção visual). |
| "Tríceps Inverso na Polia" → "Tríceps Pegada Inversa na Polia" | **DONE** | Rename por ID. |
| Adicionar "Francês Unilateral na Polia" | **DONE (já existia)** | Já cadastrado como "Tríceps Francês Unilateral na Polia" (grafia com "Tríceps" no início), com gif próprio. Nenhuma duplicata criada. |
| Duplicidade "Tríceps Pulley" vs "Tríceps Corda" | **DONE (nenhuma ação — confirmado distinto)** | `freeDbId` e gif diferentes (barra vs corda) confirmados — são variações reais, não duplicata. |
| Remover "Tríceps Testa (Skull Crusher)" | **DONE** | Arquivado (`status='archived'`), removido do seed ativo e do dicionário de aliases. **0 fichas ativas** referenciam esse id no banco local (tabela nova, sem dado de produção para auditar aqui — ver seção "Produção" abaixo). |

## 4. COSTAS

| Item | Status | Detalhe |
|---|---|---|
| "Bom Dia (Good Morning)" sai de `costas` | **DONE** | `body_part: 'costas' → 'perna'`. Decisão: segue o mesmo precedente já usado no catálogo para "Terra Sumo" (hip-hinge de cadeia posterior classificado em `perna`, apesar do eretor da espinha entrar no movimento) — `targetMuscle` continua "Eretor da espinha" (não mudou, é descritivo, não categórico). |
| "Levantamento Terra" também em Pernas | **DONE, com limitação técnica documentada** | `body_part` é campo **único** — não dá para o exercício aparecer em duas categorias sem mudar o modelo de dados (fora de escopo desta curadoria). Mantido `body_part='costas'` (targetMuscle é eretor da espinha) e **adicionada a tag `'perna'`**. Isso ajuda a busca livre (`GET /exercises?q=perna` também varre `tags`, confirmado em `exerciseLibraryService.ts`), mas **não** faz o exercício aparecer no chip de categoria "Perna" do seletor — tanto `FREE_WORKOUT_GROUPS` (aluno) quanto o `CATALOG_GROUPS` do builder do personal filtram por `LOWER(body_part) = $n`, igualdade exata, sem OR com tags. Achado de produto a decidir: se o usuário quiser aparição real na categoria "Perna", precisa de uma mudança de schema (`body_parts text[]` ou tabela de categorias N:N) — fora do escopo desta tarefa de curadoria de dados. |
| "Meio Terra" como representante único em Costas | **BLOCKED — premissa não confirmada** | "Meio Terra" **não existe** no catálogo atual (confirmado por grep nos dois arquivos de seed) nem tem equivalente verificável no gifdotreino (busquei "rack pull", "levantamento parcial", "meio terra" — nada). Não fabriquei um exercício novo sem mídia verificada só para satisfazer o pedido. Como resultado, "manter **apenas** Meio Terra em Costas" não foi possível — "Levantamento Terra" continua em Costas pelo motivo acima, e "Meio Terra" simplesmente não existe. Recomendo ao usuário decidir: (a) desistir do "Meio Terra" como conceito, ou (b) eu cadastro o exercício sem gif (documentado como tal) numa rodada seguinte. |
| "Terra Sumo" vs "Levantamento Terra" vs "Meio Terra" | **DONE (nenhuma ação — confirmado distinto)** | "Terra Sumo" já existe com nome e gif próprios, `body_part='perna'` — não foi confundido com os outros dois. |
| Corrigir gif "Pulldown" (em pé) | **DONE** | Identificado como "Pulldown com Braços Retos" (o único exercício com "Pulldown" isolado no nome). **Confirmado visualmente**: o gif antigo (`Pullover com Cabo.gif`) era na verdade um **pullover DEITADO no banco** — exercício diferente. Novo gif verificado: `Exercicios/Costas/Pulldown com corda.gif` (em pé, puxada reta com corda na polia alta, dorsal destacado). |
| "Puxada na Polia Alta (Close Grip)" → "Puxada Supinada Fechada" | **DONE** | Rename por ID (alias sincronizado). |
| "Remada Invertida" → "Remada Livre" | **DONE** | Rename por ID. |
| "Remada T-Bar" → "Remada Cavalinho" | **DONE** | Rename por ID (alias sincronizado). |
| Adicionar "Puxada Supinada Aberta" | **DONE** | Novo. Gif: **BLOCKED** (nenhuma wide-grip underhand pulldown verificada, distinta da "Puxada Supinada" já existente); fallback `freeDbId: 'Underhand_Cable_Pulldowns'`. |
| Adicionar "Remada Curvada com Halter" | **DONE** | Novo, gif verificado: `Exercicios/Costas/Remada curvada com halteres.gif` (bilateral, tronco inclinado ~45°, dois halteres). |
| "Remada Baixa na Máquina" — avaliação de implementação | **DONE — decisão registrada** | Avaliei (A) 3 exercícios por pegada vs (B) 1 exercício com seleção de pegada em UI. **Escolhido (A)**, pelo padrão JÁ EM USO no catálogo (Puxada Supinada vs Pronada já são exercícios distintos; Tríceps Pulley barra vs corda idem) — (B) exigiria um campo novo de "variante" no modelo/seletor de exercício, inexistente hoje, o que seria uma feature nova fora do escopo de curadoria de conteúdo. Cadastrados os 3: "Remada Baixa na Máquina — Pegada Supinada/Pronada/Neutra". Gif: **BLOCKED** para os 3 (nenhum remada-baixa-de-máquina com pegada específica verificado no gifdotreino); fallback `freeDbId: 'Seated_Cable_Rows'`. |
| Corrigir gif "Superman com Alternância" | **BLOCKED** | Confirmado que compartilha gif com "Superman (Extensão Dorsal no Chão)" (`Superman.gif`). Busquei variantes alternadas (braço+perna opostos, prona) — só achei "Quadrúpede com elevação de braço e perna contralateral" (Bird Dog), que é uma posição corporal DIFERENTE (quatro apoios, não deitado de bruços) — usá-lo substituiria um erro por outro. Sem gif fiel encontrado, mantido como está. |

## 5. PERNAS / GLÚTEOS / POSTERIOR

| Item | Status | Detalhe |
|---|---|---|
| "Afundo (Lunge)" → "Afundo com Halter" | **DONE** | Rename por ID (alias sincronizado). |
| "Nordic Curl (Curl Nórdico)" → "Flexão Nórdica" | **DONE** | Rename por ID (alias sincronizado). |
| "Glúteo 4 Apoios (Donkey Kick)" → "Glúteo 4 Apoios" | **DONE** | Rename por ID (alias sincronizado). |
| Remover "Extensão de Perna na Máquina" | **DONE** | Arquivado + removido do seed/mapa. |
| Remover "Panturrilha em Pé (Calf Raise)" | **DONE** | Arquivado + removido do seed/mapa. |
| Remover "Frog Pump" | **DONE** | Arquivado + removido do seed/mapa (satélite). |
| Remover "Glute Kickback de Joelhos" | **DONE** | Arquivado + removido do seed/mapa. |
| Corrigir gif "Leg Press 80°" | **DONE, com ressalva** | Confirmado que compartilhava `Leg Press.gif` com o 45°. Melhor candidato distinto encontrado: `Exercicios/Pernas/Leg press 90 no smith.gif` — é **90° no Smith** (deitado no chão, empurrando a barra numa gaiola Smith), não literalmente 80° numa máquina de leg press dedicada — mas é a variante de ângulo mais íngreme/vertical disponível no catálogo de origem, mais fiel ao conceito "leg press de ângulo alto" do que continuar compartilhando o gif do 45°. Documentado como aproximação, não como 80° exato. |
| Adicionar "Leg Press 45° Unilateral" | **DONE** | Gif verificado: `Exercicios/Pernas/Leg Press unilateral.gif` (confirmado visualmente: um pé na plataforma, isolado). |
| Adicionar "Leg Press 45° Articulado" | **DONE** | Gif: **BLOCKED** (nenhuma variante "articulado" distinta do sled tradicional encontrada); fallback `freeDbId: 'Leg_Press'`. |
| "Passada Caminhando" → "Passada com Barra" / "Passada com Halter" | **DONE — decisão registrada** | Reaproveitado o ID existente de "Passada Caminhando" para **"Passada com Barra"** (rename por ID) — o `freeDbId` já era `Barbell_Walking_Lunge` e o gif do gifdotreino já era `Avanço com Barra.gif`, coerente. **"Passada com Halter"** cadastrado como item **novo**, reusando (sem gif próprio verificado) o gif de "Afundo com Halter" (`Afundo com Halteres.gif`) — nenhuma passada-caminhando-com-halteres distinta foi encontrada no gifdotreino; documentado que o gif é compartilhado/aproximado, não exclusivo. |
| Duplicidade "Abdução de Quadril na Máquina" vs "Abdução na Máquina" | **DONE** | Mesmo `freeDbId`/gif confirmado. Mantido "Abdução de Quadril na Máquina" (mais descritivo); "Abdução na Máquina" arquivado + removido do seed/mapa. |

## 6. ABDÔMEN / CORE

| Item | Status | Detalhe |
|---|---|---|
| Corrigir gif: Abdominal Bicicleta, Abdominal Infra, Abdominal Remador, Escalador com Torção, Leg Raise Deitado, Mountain Climber | **BLOCKED (6 itens)** | Busca ampla no catálogo completo do gifdotreino (963 itens) não encontrou nenhuma variante MELHOR/mais específica do que a já mapeada (todas com confiança "medium/low" no `gifDoTreino.mapping-review.md`, mas sem alternativa real disponível na fonte). Trocar por algo pior não seria correção. |
| Corrigir gif: Dead Bug, Hollow Body Hold, L-Sit | **BLOCKED (confirmado GAP, lista revalidada)** | Busquei ativamente (não confiei só na lista antiga do `mapping-review.md`) — zero resultados para "dead bug", "hollow body", "l-sit" nos 963 itens do catálogo de origem. A lista de GAP estava correta e atualizada para esses 3. |
| Adicionar gif "Crunch Abdominal" / "Crunch na Bola" | **DONE (nenhuma ação — premissa incorreta)** | **Correção ao pedido**: os dois **já tinham** gif (`Contração abdominal.gif`, genérico, compartilhado com "Abdominal Completo"/"Crunch com Cabo") — não estavam "sem gif" como a investigação prévia sugeria. Busquei um gif de bola suíça específico para "Crunch na Bola" e não achei nada melhor; mantive o genérico já existente. |
| Adicionar/verificar "Oblíquo com Rotação" | **DONE (já existia)** | Já cadastrado, com gif (`Torção Oblíqua Sentada.gif`, compartilhado com Twist Russo). Nenhuma duplicata criada. |
| Adicionar/verificar "Pallof Press" | **DONE** | Não existia — cadastrado novo. Mídia: **imagem estática verificada** do free-exercise-db (`Pallof_Press`, com foto real no snapshot) — não é GIF animado do gifdotreino (não encontrado lá), mas é mídia real, não fabricada. |
| Revisão de TODOS os exercícios de prancha | **BLOCKED — premissa não confirmada** | Busquei "prancha"/"plank" nos 963 itens do gifdotreino: **zero resultados**. Nenhuma variante de prancha (`Prancha`, `Prancha Isométrica`, `Prancha Lateral`, `Prancha com Toque no Ombro`, `Prancha com Elevação de Quadril`, `Hollow Body Hold`) tem gif do gifdotreino hoje — todas usam o mesmo fallback estático genérico (`Plank` do free-exercise-db) ou nada. **Não existe, portanto, gif "trocado entre variantes"** para corrigir — a fonte simplesmente não tem conteúdo de prancha. Achado a reportar, não uma correção aplicada. |
| Dividir "Twist Russo" em com/sem peso | **BLOCKED** | Nenhuma variante distinta (com peso vs sem peso) encontrada no gifdotreino — só existe `Torção Oblíqua Sentada.gif`, já em uso. Decidi **não dividir** o exercício: criar dois itens reaproveitando o MESMO gif não seria "cada um com gif próprio e correto" como pedido — seria só duplicar o nome sem resolver a diferenciação visual real. Mantido "Twist Russo" único. |

## 7. CARDIO / FUNCIONAL

| Item | Status | Detalhe |
|---|---|---|
| Corrigir gif "Caminhada na Esteira" | **BLOCKED** | Compartilha `Esteira Ergométrica.gif` com "Corrida na Esteira" e "Esteira (HIIT)". Nenhuma variante de "caminhada" (ritmo mais lento, distinta de corrida) encontrada no catálogo de origem. |
| "Polichinelo" — duplicidade | **DONE (nenhuma ação — confirmado, premissa do usuário não se sustentava)** | Confirmado: "Polichinelo" é só um **alias/tag de busca** de "Polichinelo (Jumping Jack)" (`COMMON_GYM_EXERCISE_ALIASES['Polichinelo (Jumping Jack)'] = ['Polichinelo']`), não um exercício separado. O pedido do usuário partiu de uma premissa que não se confirmou — reportado para que ele saiba que não havia duplicata real ali. |

## 8. ALONGAMENTOS

7 exercícios novos adicionados com gif **verificado** (HTTP 200 + inspeção visual em pontos de
incerteza), `body_part: 'mobilidade'` (categoria já existente, não criei categoria nova) + tags
`'alongamento'` e o grupo-alvo:

| Grupo | Status | Exercício |
|---|---|---|
| Tríceps | **DONE** | "Alongamento de Tríceps em Pé" |
| Costas | **DONE** | "Alongamento de Costas" |
| Lombar | **DONE** | "Alongamento Lombar" (postura da cobra — confirmado visualmente, lombar destacada) |
| Quadríceps | **DONE** | "Alongamento de Quadríceps em Pé" |
| Posterior de coxa | **DONE (já coberto)** | Já existe "Alongamento de Isquiotibiais (Faixa)" — nenhum item novo necessário |
| Glúteos | **DONE** | "Alongamento de Glúteos" |
| Adutores | **DONE** | "Alongamento de Adutores Sentado" |
| Abdutores | **BLOCKED** | Nenhum alongamento de abdutor dedicado encontrado no gifdotreino (busquei "abdutor", "abdução perna" — só achei exercícios de FORÇA de abdução, não alongamento) |
| Panturrilhas | **DONE** | "Alongamento de Panturrilha na Parede" |
| Quadril | **DONE (já coberto)** | Já existem "Hip 90/90" e "Pigeon Pose" — nenhum item novo necessário |
| Ombros | **DONE (já coberto)** | Já existe "Mobilidade de Ombro (Towel Stretch)" — nenhum item novo necessário |
| Peitoral | **DONE (já coberto)** | Já existe "Chest Stretch (Alongamento de Peitoral)" — nenhum item novo necessário |

**Cobertura final: 10 de 12 grupos pedidos têm pelo menos um alongamento** (7 novos + 3 já
existentes); 2 bloqueados por falta de mídia verificável (Bíceps, Abdutores).

## 9. Revisão geral (best-effort, não exaustiva)

**GIFs de ORIGEM (gifdotreino) compartilhados entre exercícios diferentes**, via
`grep`/análise dos VALORES do mapa (não da URL final gravada no banco — a URL final é sempre
única por ser derivada do NOSSO nome, então uma comparação pela URL gravada no banco não
revela isso; comparar pelos valores do mapa é o jeito certo). 18 grupos, dos quais os já
tratados nesta curadoria (Leg Press 45°/80°, Abdução de Quadril, Encolhimento — resolvidos
acima) não aparecem mais porque passaram a ter mídia própria ou foram arquivados. Os que
sobraram, para o usuário priorizar depois:

```
Abdominal Canivete | Abdominal Remador
Abdominal Completo | Crunch Abdominal | Crunch com Cabo | Crunch na Bola
Abdominal Infra (Elevação de Pernas) | Leg Raise Deitado
Afundo com Halter | Passada com Halter   ← reuso intencional desta curadoria, documentado acima
Agachamento Sumo | Agachamento Sumô
Caminhada na Esteira | Corrida na Esteira | Esteira (HIIT)
Crossover Polia Média | Crossover no Cabo
Escalador com Torção | Mountain Climber
Flexão Diamante | Flexão de Braço Fechada
Flexão de Braço | Flexão de Braço Larga | Staggered Push-Up (Flexão Assimétrica) | Tempo Push-Up (Flexão Lenta)
Jumping Jacks | Polichinelo (Jumping Jack)
Oblíquo com Rotação | Twist Russo
Remada Baixa no Cabo | Remada Sentada no Cabo
Remada com Elástico | Remada com Elástico na Porta
Rosca 21 com Barra | Rosca Direta com Barra
Superman (Extensão Dorsal no Chão) | Superman com Alternância   ← já reportado acima, BLOCKED
Tríceps Francês na Polia | Tríceps Francês na Polia Baixa   ← ATENÇÃO: esse par já compartilhava gif ANTES desta curadoria (só o nome de um dos dois mudou aqui); ficou mais parecido depois do rename — vale revisão de produto se "na Polia" e "na Polia Baixa" ainda fazem sentido como exercícios separados
```

**Exercícios sem mídia alguma** (nem gifdotreino, nem free-exercise-db): apenas **2** no catálogo
inteiro pós-curadoria — "Cat-Cow (Mobilidade de Coluna)" (pré-existente, não fazia parte deste
pedido) e "Rosca Inversa com Desenvolvimento" (adicionado nesta curadoria, já documentado acima
como BLOCKED de mídia).

## Decisões de produto tomadas nesta curadoria (para o usuário confirmar/reverter)

1. **Remada Baixa na Máquina**: 3 exercícios separados por pegada, não 1 com seletor de
   variante (motivo: consistência com o padrão já usado no catálogo; criar seletor de variante
   seria feature nova, fora de escopo de curadoria de conteúdo).
2. **Levantamento Terra**: continua em `costas`, ganhou tag `perna` (não aparece no chip de
   categoria "Perna" — limitação de `body_part` ser campo único, documentada acima).
3. **Meio Terra**: não criado — não existia e não achei gif verificável; premissa do pedido
   não se sustentou.
4. **Twist Russo**: não dividido em com/sem peso — dividir sem gif distinto para cada um não
   seria uma correção real.
5. **Rosca Inversa com Cabo / na Polia**: tratados como o mesmo exercício (mesma peça de
   equipamento no vocabulário já usado no catálogo) — só "Rosca Inversa na Polia" foi criado.
6. **Passada com Barra**: reaproveitou o ID de "Passada Caminhando" (rename), em vez de criar
   linha nova — o `freeDbId`/gif já eram exatamente os pedidos para essa variante.
7. **"Bíceps Curl to Shoulder Press"**: nomeado em PT-BR como "Rosca Inversa com
   Desenvolvimento".

## Comandos para rodar em produção

**Nunca rodado neste trabalho contra produção** — só contra bancos locais (`corefitdb_test`,
`corefitdb_test_pre`, porta 5433). Depois do deploy que leva os arquivos de seed editados:

```bash
# 1) aplica os renames/archives por ID + roda o reseed (novos itens + mídia corrigida)
DATABASE_URL=<DATABASE_URL de produção> \
  npx tsx src/scripts/curationExerciseLibraryFixes2026Q3.ts

# 2) propaga os GIFs corrigidos/novos para eventuais cópias 'metacore' de mesmo nome
#    (mesmo script já usado sempre que se corrige gif de exercício existente — ver
#    memória "Exercises: dois sources corefit + metacore")
DATABASE_URL=<DATABASE_URL de produção> \
  npx tsx src/scripts/propagateGifMedia.ts

# 3) espelha os GIFs novos/corrigidos do gifdotreino para o bucket público (R2) —
#    só baixa/sobe o que ainda não existe lá, idempotente
DATABASE_URL=<DATABASE_URL de produção> \
  EXERCISE_MEDIA_S3_BUCKET=<bucket> EXERCISE_MEDIA_BASE_URL=<base pública> \
  AWS_S3_ENDPOINT=<endpoint R2> AWS_ACCESS_KEY_ID=<...> AWS_SECRET_ACCESS_KEY=<...> \
  npx tsx src/scripts/mirrorGifDoTreino.ts
```

O script (1) é **idempotente** — pode ser rodado de novo sem medo (renames já aplicados viram
no-op "already-applied", archives já feitos viram "already-archived", o reseed sempre foi
idempotente). A ordem 1 → 2 → 3 importa: (2) e (3) dependem dos nomes/mapa já corrigidos por
(1)/pelos arquivos de seed editados neste PR.

## Verificação executada

- `tsc --noEmit`: **limpo** (0 erros).
- `npm run lint`: **0 erros**, 510 warnings pré-existentes (nenhum nos arquivos tocados por
  esta curadoria).
- `npm run build`: **passou**.
- `npx jest --runInBand` (suíte completa do backend): **75 suítes, 1117 testes, todos
  passando** (0 regressão).
- Suíte nova `src/__tests__/curation-exercise-library-2026q3.integration.test.ts` (3 testes,
  banco real via `TEST_DATABASE_URL`): rename por ID não duplica (mesmo rodado 2x), archive
  não quebra id referenciado por uma "ficha" (nunca DELETE), correção de mídia primária nunca
  deixa duas linhas `is_primary=true` para o mesmo exercício.
- Todas as **229 URLs finais** do `gifDoTreino.map.ts` (após todas as edições) reverificadas em
  lote com HTTP 200.
- Testado ponta a ponta em banco recriado do zero a partir do seed **pré-curadoria** (via
  `git stash` temporário dos 3 arquivos de seed) — confirma que o script de curadoria de fato
  MUDA dado real (renomeia, arquiva) e não só confirma um estado que já nasceu correto.
