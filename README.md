# Tick

App pessoal de ponto (batidas, banco de horas, ocorrências, Excel), instalável no celular e no PC.
Tudo roda em **um Worker só** no Cloudflare, chamado `tick`:

| Pasta | O que é |
|---|---|
| `public/` | O app (tela, modo offline `sw.js`, ícones) |
| `src/worker.js` | Servidor: guarda os dados, envia as notificações e roda o agendamento a cada minuto |
| `wrangler.jsonc` | Configuração: KV `tick-dados` (binding `DADOS`) e o agendamento `* * * * *` |

Nada precisa ser configurado à mão no painel: o `wrangler.jsonc` define tudo a cada publicação.

## Publicar (Cloudflare ligado ao GitHub)

Workers & Pages → `tick` → Settings → Build → Connect → escolher este repositório:

- Branch: `main`
- Build command: *(vazio)*
- Deploy command: `npx wrangler deploy`

Depois disso, cada alteração enviada para o `main` publica sozinha.

## Diagnóstico das notificações

Abrir `https://tick.<sua-conta>.workers.dev/api/status`: mostra usuários, aparelhos cadastrados,
a última verificação do agendamento (gravada a cada 15 min) e o último envio.

No app: ⚙ → **Testar lembrete agendado**. Se chegar com o app fechado, os lembretes de ponto chegam também.

## Chave de acesso

O app cria a própria chave na primeira vez que abre. O servidor aceita até 5 chaves (variável opcional `MAX_USERS`).
Para usar no PC com os mesmos dados: no celular, ⚙ → **Copiar link para outro aparelho**.

> Não coloque chaves ou senhas neste repositório.
