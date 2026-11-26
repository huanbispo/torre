# Torre

Terminal para vários agentes de código no Windows: agentes à vista na lateral, terminais em grade e um
painel com o código mudando. Electron + xterm.js + ConPTY (node-pty).

## Rodar

```powershell
npm install
npm run dev      # desenvolvimento, com recarga da interface
npm start        # compila e abre a versão de produção
```

`npm run typecheck` confere os tipos do processo principal e da interface.

## Atalhos

| Atalho | Faz |
| --- | --- |
| Ctrl+Shift+N | Novo agente (abre `claude` na pasta escolhida) |
| Ctrl+Shift+T | Novo terminal (PowerShell) |
| Ctrl+1…9 | Pula para a sessão |
| Ctrl+Shift+A | Vai para a próxima sessão que espera você |
| Ctrl+Shift+G / Q / R | Tela Grade, Quadro ou Revisão |
| Ctrl+Shift+D | Minimiza ou abre o painel de mudanças |
| Ctrl+Shift+M | Maximiza a sessão em foco, ou volta à grade |
| Ctrl+Shift+W | Fecha a sessão em foco |
| Shift+Enter | Quebra de linha no Claude Code |
| Ctrl+C com seleção, Ctrl+V, botão direito | Copiar e colar |
| F12 | Ferramentas de desenvolvedor |

## As três telas

- **Grade:** os terminais lado a lado, a lateral com cada sessão e os subagentes dela (nome da
  tarefa e o que cada um faz agora), e o painel de mudanças.
- **Quadro:** um cartão por sessão, com uma faixa para o agente principal e uma para cada
  subagente: estado, tempo, número de ferramentas e os últimos passos. À direita, a atividade de
  todos em ordem de tempo. É a tela para acompanhar sem ler terminal.
- **Revisão:** lista de arquivos, diff lado a lado e o terminal da sessão em foco. Um clique numa
  linha abre um comentário, que vai ao agente como mensagem (`[arquivo:linha] texto`).

Os terminais continuam montados nas três telas (escondidos no Quadro), para os processos não
morrerem ao trocar de tela.

## Ajustar a tela

- **Tamanho dos terminais:** arraste a divisa entre dois painéis ou entre duas fileiras. Cada fileira
  tem as suas larguras. Dois cliques na divisa igualam de novo.
- **Um terminal em destaque:** o botão de quadrado no cabeçalho do painel, dois cliques no cabeçalho
  ou Ctrl+Shift+M maximizam; os outros continuam rodando.
- **Painel de mudanças:** arraste a borda esquerda para mudar a largura (dois cliques voltam ao
  padrão); o botão » ou Ctrl+Shift+D minimiza para uma faixa que ainda mostra o total de linhas.

O app lembra esses ajustes entre aberturas, um arranjo para cada formato de grade (2 painéis, 2+1,
2+2, 3+3…). Ficam em `%APPDATA%\torre\state.json`, junto com as pastas recentes.

## Como está organizado

- `src/main` — processo principal: janela, PTYs (`pty.ts`), git e vigia de arquivos (`git.ts`).
- `src/preload` — a ponte `window.torre` entre a interface e o processo principal.
- `src/renderer` — a interface em React: `App.tsx` (lateral, grade, atalhos), `TerminalView.tsx`
  (xterm.js), `DiffPanel.tsx` (mudanças).
- `src/shared/types.ts` — os tipos que os três lados compartilham.

## Estado de cada sessão

Um agente aberto pelo app ("Novo agente") roda `claude --settings <arquivo>`, e esse arquivo liga os
hooks do Claude Code só naquela sessão; o `settings.json` do usuário não é tocado. A cada evento o
Claude Code roda `torre-hook.cjs`, que manda uma linha de JSON ao app por um named pipe
(`TORRE_PIPE`), com o id do painel (`TORRE_PANE`). Os dois arquivos são gravados em
`%APPDATA%\torre\hook` a cada abertura do app.

| Evento | O que muda na tela |
| --- | --- |
| UserPromptSubmit, PreToolUse, PostToolUse | "trabalhando", com a última ferramenta na lateral |
| PermissionRequest, Notification de permissão | "esperando você", anel âmbar no painel |
| Stop, StopFailure | "terminou", com o começo da última resposta |
| SubagentStart, SubagentStop | o subagente entra na lateral e no Quadro, com o nome da tarefa (tirado da chamada `Agent` do principal) |
| Eventos de ferramenta com `agent_id` | o passo vai para a faixa daquele subagente, não para a do principal |
| PostToolUse de Edit ou Write | selo "editado há N s" no arquivo e painel de mudanças relido na hora |

Interromper um turno com Esc não dispara hook nenhum; por isso "trabalhando" sem evento e sem saída
no terminal por 6 s vira "parado". Com a janela fora de foco, "esperando você" e "terminou" piscam a
barra de tarefas e mandam um aviso do Windows.

Sem hooks (um terminal comum, ou um `claude` aberto à mão num terminal) o estado é estimado pelo
próprio terminal: saída recente quer dizer "trabalhando", silêncio "parado", e sino ou OSC 9/99/777
acendem o "esperando você". A lógica dos eventos está em `src/renderer/src/agent.ts`, e o lado do
processo principal em `src/main/hooks.ts`.

## Painel de mudanças e vários repositórios

O painel mostra os repositórios da sessão em foco:

- o repositório da pasta onde a sessão abriu, se ela estiver dentro de um;
- o repositório de cada arquivo que o agente editou (sabido pelo hook de Edit e Write), esteja onde
  estiver: uma pasta irmã, um repositório dentro da pasta-mãe, outro disco.

Com mais de um, os arquivos aparecem agrupados por repositório, cada grupo com o nome, o ramo e o
total de linhas. Uma sessão aberta numa pasta-mãe que não é repositório começa com o painel vazio e
ganha um grupo a cada repositório que o agente toca. Mudanças feitas por comando (`sed`, um script,
`git checkout`) num repositório que o agente ainda não editou não entram: o app só sabe do
repositório depois de uma edição ali. O vigia acompanha até 8 repositórios por sessão.

## Autoteste

Variáveis de ambiente que abrem o app num estado conhecido e fotografam a janela:

- `TORRE_OPEN="agent|D:\pasta;shell|D:\outra"` abre já com essas sessões.
- `TORRE_SHOT=<arquivo.png>` salva uma captura depois de `TORRE_SHOT_DELAY` ms (padrão 9000) e sai.
- `TORRE_TYPE=<texto>` digita o texto e Enter no painel em foco, `TORRE_TYPE_DELAY` ms depois de
  abrir (padrão 4000).
- `TORRE_HOOK_LOG=<arquivo>` guarda cada evento de hook recebido, uma linha de JSON por evento.
- `TORRE_VIEW=board|review` troca de tela `TORRE_VIEW_DELAY` ms depois de abrir.
- `TORRE_USER_DATA=<pasta>` troca a pasta de dados do app, para o teste não mexer nas pastas
  recentes e nos ajustes de tela de quem usa o app (os arquivos de hook também vão para lá).
- `TORRE_DRAG="x1,y1,x2,y2"` arrasta o mouse de um ponto ao outro (pontos iguais dão um clique).

## Fases

1. Terminais na grade — feito.
2. Agentes à vista por hooks do Claude Code — feito.
3. Painel de mudanças — versão básica feita (diff contra HEAD, arquivos novos, atualização ao salvar).
4. Telas Quadro e Revisão — feitas; faltam responder permissão pelo Quadro, commit e PR pela Revisão.
5. Worktree por agente, restaurar layout, retomar sessões — a fazer.
