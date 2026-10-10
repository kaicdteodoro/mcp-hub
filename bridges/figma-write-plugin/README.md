# PB Figma Write Bridge Plugin

Plugin local para desenvolvimento do bridge de escrita no Figma.

## O que ele faz

- conecta ao serviço local `local-figma-write-service.mjs`
- registra uma sessão para o arquivo aberto no Figma
- recebe comandos pendentes (`find_nodes`, `dry_run`, `batch_apply`)
- executa as operações via Plugin API
- devolve o resultado ao serviço local, que por sua vez responde ao `mcp-hub`

## Como usar

1. Inicie o serviço local:
   - `npm run figma-write:bridge`
2. No Figma Desktop:
   - `Plugins` → `Development` → `Import plugin from manifest...`
   - selecione [`manifest.json`](./manifest.json)
3. Rode `Start Bridge Agent`
4. Opcionalmente rode `Configure Bridge` para ajustar URL, token ou `fileKeyOverride`
5. No `mcp-hub`, configure:
   - `FIGMA_WRITE_BRIDGE_MODULE=./bridges/http-figma-write-bridge.mjs`
   - `FIGMA_WRITE_BRIDGE_URL=http://127.0.0.1:3847`

## Uso no Linux via Figma web

Se você não quiser depender do desktop app, publique o plugin como plugin privado da organização e rode-o no navegador.

Guia:

- [`PUBLISH_PRIVATE.md`](./PUBLISH_PRIVATE.md)

Nesse modo:

- o browser no Linux fala com a bridge local em `http://127.0.0.1:3847`
- o plugin continua usando o mesmo `code.js` e `ui.html`
- o fluxo de `dry_run` e `batch_apply` não muda

## Observações

- O acesso a `figma.fileKey` depende de plugin privado com `enablePrivatePluginApi`.
- Se `figma.fileKey` não estiver disponível no ambiente atual, use `fileKeyOverride`.
- O plugin foi desenhado para o fluxo de desenvolvimento local da Pensando Bem; não é um plugin publicado.
  Agora ele também pode ser usado como plugin privado publicado, desde que a organização aceite o escopo de rede declarado no manifesto.
