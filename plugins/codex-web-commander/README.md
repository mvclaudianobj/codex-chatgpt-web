# Codex Web Commander

Plugin isolado que expõe três ferramentas MCP somente leitura por HTTP JSON-RPC:

- `workspace_status`: informa metadados do workspace selecionado.
- `list_directory`: lista entradas dentro do workspace.
- `read_file`: lê texto com limites de bytes e linhas.

Não há shell, execução de processos, escrita, exclusão, automação de desktop ou OAuth nesta versão.

## Execução local

Requer Bun já disponível no projeto. A chave é obrigatória; o servidor não usa `process.cwd()` como workspace implícito.

```bash
CODEX_WEB_COMMANDER_API_KEY='troque-esta-chave' \
CODEX_WEB_COMMANDER_WORKSPACE='/caminho/absoluto/do/workspace' \
bun run plugins/codex-web-commander/src/index.ts
```

Padrões: bind `127.0.0.1:18182`. Podem ser alterados por `CODEX_WEB_COMMANDER_HOST`, `CODEX_WEB_COMMANDER_PORT`, `CODEX_WEB_COMMANDER_WORKSPACE` e `CODEX_WEB_COMMANDER_CORS_ORIGIN` (origens exatas separadas por vírgula). Cada chamada também pode informar `cwd` absoluto.

## Exemplo

```bash
curl -sS http://127.0.0.1:18182/mcp \
  -H 'Authorization: Bearer troque-esta-chave' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`GET /healthz` não exige autenticação. `POST /mcp` exige Bearer e aceita `initialize`, `tools/list` e `tools/call`. O corpo é limitado a 1 MiB; leituras e listagens também têm limites próprios.

## ChatGPT Pro / Connector

Este plugin não instala nada automaticamente na conta ChatGPT. Para uma futura configuração como Connector MCP no ChatGPT Pro, é necessário publicar o endpoint por HTTPS público usando um tunnel ou reverse proxy controlado pelo operador e configurar o Connector em Developer Mode, conforme a disponibilidade da conta e da interface do ChatGPT.

O serviço deve continuar protegido por uma chave forte e o proxy deve encaminhar somente `/mcp` e, se desejado, `/healthz`. Exemplo conceitual, sem segredos:

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.test;
    location / {
        proxy_pass http://127.0.0.1:18182;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

O HTTPS público, o tunnel, certificados, controle de acesso e eventual fluxo OAuth ficam fora deste plugin. Não compartilhe a chave em repositórios, URLs ou documentação pública.
