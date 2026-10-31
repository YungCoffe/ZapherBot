# Comandos do Zapher Bot (versão 2.7.0)

São **100 comandos**: 97 funcionam com `/` e com o prefixo `?`, e 3 funcionam **só com o prefixo** (`?backup`, `?logs`, `?setup`).
Em cada linha: `<obrigatório>` `[opcional]`. A permissão entre parênteses é a que o Discord exige de quem usa (Administrador usa tudo). A lista é gerada a partir do código e é a mesma que aparece em `/help`.

## 🛡️ Moderação (19)

- `/ban <usuario> [minutos] [motivo]` — Bane um membro do servidor *(🔒 Banir Membros)*
- `/unban <usuario>` — Remove o banimento de um usuário *(🔒 Banir Membros)*
- `/kick <usuario> [motivo]` — Expulsa um membro *(🔒 Expulsar Membros)*
- `/mute <usuario> <minutos> [motivo]` — Silencia um membro por tempo determinado *(🔒 Silenciar Membros)*
- `/unmute <usuario>` — Remove o silenciamento de um membro *(🔒 Silenciar Membros)*
- `/warn <usuario> <motivo>` — Avisa um membro *(🔒 Silenciar Membros)*
- `/warnings <usuario>` — Mostra os avisos de um membro
- `/clearwarns <usuario>` — Apaga todos os avisos de um membro *(🔒 Silenciar Membros)*
- `/clear <qtd> [usuario]` — Limpa mensagens *(🔒 Gerenciar Mensagens)*
- `/calado <usuario>` — Deixa um membro calado (apaga todas as mensagens dele) *(🔒 Silenciar Membros)*
- `/lock` — Tranca o canal atual *(🔒 Gerenciar Canais)*
- `/unlock` — Destranca o canal atual *(🔒 Gerenciar Canais)*
- `/slowmode <segundos>` — Define o modo lento do canal atual *(🔒 Gerenciar Canais)*
- `/setcargo <usuario> <cargo>` — Adiciona ou remove um cargo de um membro *(🔒 Gerenciar Cargos)*
- `/nick <usuario> <apelido>` — Altera o apelido de um membro *(🔒 Gerenciar Apelidos)*
- `/permnick <usuario> <apelido>` — Trava o apelido de um membro permanentemente *(🔒 Gerenciar Apelidos)*
- `/unpermnick <usuario>` — Destrava o apelido de um membro *(🔒 Gerenciar Apelidos)*
- `/censura <add|remove|list> [palavra]` — Gerencia palavras censuradas *(🔒 Gerenciar Mensagens)*
- `/automod <status>` — Ativa ou desativa o automod de links *(🔒 Gerenciar Servidor)*

## ⚙️ Configuração (19)

- `?setup [completo|atualizar|tickets|emojis]` — Recria o servidor do zero: cargos, canais, logs, permissões, níveis, tickets e painéis *(🔒 Gerenciar Servidor)*
- `/setwelcome <canal>` — Define o canal de boas-vindas *(🔒 Gerenciar Servidor)*
- `/setlogs <canal>` — Define o canal de logs geral *(🔒 Gerenciar Servidor)*
- `/setdenuncias <canal>` — Define o canal de logs de denúncias *(🔒 Gerenciar Servidor)*
- `/setduvidas <canal>` — Define o canal de logs de dúvidas *(🔒 Gerenciar Servidor)*
- `/setpunicoes <canal>` — Define o canal de logs de punições *(🔒 Gerenciar Servidor)*
- `/setmsgdelete <canal>` — Define o canal de logs para mensagens apagadas *(🔒 Gerenciar Servidor)*
- `/setsuggestion <canal>` — Define o canal de sugestões *(🔒 Gerenciar Servidor)*
- `/setnivel <canal>` — Define o canal dos avisos de subida de nível *(🔒 Gerenciar Servidor)*
- `?logs [apagadas|editadas|punicoes|tickets|entradas|saidas|nivel|testar] [status]` — Liga/desliga cada tipo de log e aviso do bot (vazio = ver o que está ativo) *(🔒 Gerenciar Servidor)*
- `/setverify <canal> <cargo>` — Envia o painel de verificação por botão *(🔒 Gerenciar Servidor)*
- `/setautorole <cargo>` — Define o cargo automático para novos membros *(🔒 Gerenciar Servidor)*
- `/delautorole` — Remove o cargo automático de novos membros *(🔒 Gerenciar Servidor)*
- `/setadminrole <cargo>` — Adiciona um cargo com permissões administrativas do bot *(🔒 Administrador)*
- `/setadminuser <usuario>` — Adiciona um usuário com permissões administrativas do bot *(🔒 Administrador)*
- `/deladminrole <cargo>` — Remove um cargo da administração do bot *(🔒 Administrador)*
- `/deladminuser <usuario>` — Remove um usuário da administração do bot *(🔒 Administrador)*
- `/ia [status]` — Liga/desliga a IA neste servidor, ou mostra se está ligada (staff) *(🔒 Gerenciar Servidor)*
- `?backup [status|configurar|agora|recuperar|exportar|restaurar] [arquivo] [canal]` — Backup e restauração dos dados do bot (só o dono) *(🔒 dono do bot)*

## 💳 Economia — Conta (14)

- `/saldo [usuario]` — Consulta o teu património e extrato
- `/depositar <valor>` — Guarda dinheiro no banco
- `/sacar <valor>` — Saca dinheiro do banco
- `/transferir <usuario> <valor>` — Faz Pix/Transferência para outro membro
- `/perfil` — Mostra o teu cartão de cidadão e inventário
- `/rank` — Mostra o top 10 mais ricos do servidor
- `/extrato` — Mostra as últimas movimentações da tua conta
- `/inventario` — Mostra os itens que tens guardados
- `/emprestimo <valor>` — Pede um empréstimo ao banco
- `/pagar <valor>` — Paga a tua dívida do empréstimo
- `/vender <item>` — Vende um item do teu inventário por 50% do preço
- `/cooldowns` — Mostra quando podes usar cada comando de ganho
- `/addmoney <usuario> <valor>` — [DONO] Adiciona dinheiro a um usuário *(🔒 dono do bot)*
- `/removemoney <usuario> <valor>` — [DONO] Remove dinheiro de um usuário *(🔒 dono do bot)*

## 💼 Economia — Ganhos (14)

- `/daily` — Resgata o teu prémio diário
- `/weekly` — Resgata o teu bónus semanal
- `/trabalhar` — Trabalha para ganhar dinheiro e subir de nível
- `/profissao [entregador|vendedor|programador|medico|empresario]` — Escolhe a tua profissão (mais nível = mais ganhos)
- `/minerar` — Vai às minas procurar minérios valiosos
- `/pescar` — Vai pescar no rio
- `/cacar` — Vai caçar na floresta
- `/farmar` — Cultiva a terra para colher lucros
- `/negocios` — Compra negócios que rendem dinheiro por hora
- `/coletar` — Coleta o rendimento acumulado dos teus negócios
- `/empresa <criar|info|contratar|demitir|sair|trabalhar|coletar|salario|melhorar|fechar> [usuario] [valor] [nome]` — Crie uma empresa, contrate pessoas e divida os lucros
- `/investir <crypto|tesouro|acoes>` — Aplica dinheiro em fundos de investimento variados
- `/loteria` — Compra um bilhete de loteria por 🪙 5.000
- `/caixa` — Abre uma caixa misteriosa por 🪙 50.000

## 🎮 Jogos & Loja (8)

- `/loja` — Mostra o painel interativo da lojinha e do mercado
- `/apostar <valor> [usuario]` — Aposta dinheiro na sorte (ou desafie alguém para um duelo 50/50)
- `/slots <valor>` — Joga na máquina caça-níqueis
- `/coinflip <cara|coroa> <valor>` — Joga cara ou coroa apostando
- `/roleta <vermelho|preto|verde> <valor>` — Aposta na roleta da sorte
- `/blackjack <valor>` — Joga blackjack contra o dealer
- `/roubar <usuario>` — Tenta roubar outro membro
- `/crime` — Comete um crime arriscado na cidade

## ⭐ Níveis & Cargos (4)

- `/nivel [usuario]` — Mostra o teu nível e XP no servidor
- `/ranknivel` — Mostra o top 10 de níveis do servidor
- `/cargosnivel <criar|listar|sincronizar|remover> [abaixo_de]` — Cargos coloridos de nível: o bot cria e entrega sozinho (staff) *(🔒 Gerenciar Cargos)*
- `/painel-cargos [abaixo_de]` — Envia o painel para criar cargo personalizado (staff) *(🔒 Gerenciar Cargos)*

## 🎨 Emojis & Figurinhas (2)

- `/criaremoji <nome> [imagem] [emoji]` — Cria um emoji no servidor a partir de uma imagem ou de outro emoji *(🔒 Gerenciar Expressões)*
- `/criarfigurinha <nome> <imagem> [tags]` — Cria uma figurinha (sticker) no servidor a partir de uma imagem *(🔒 Gerenciar Expressões)*

## 🤖 IA & Diversão (7)

- `/perguntar <pergunta>` — Faz uma pergunta à inteligência artificial
- `/8ball <pergunta>` — Faz uma pergunta à bola mágica
- `/dado [lados] [quantidade]` — Rola um ou mais dados
- `/escolher <opcoes>` — O bot escolhe uma opção por ti
- `/enquete <pergunta> [opcoes]` — Cria uma enquete com reações
- `/lembrete <minutos> <texto>` — Cria um lembrete para daqui a alguns minutos
- `/sorteio <premio> <minutos>` — Cria um sorteio *(🔒 Gerenciar Mensagens)*

## 🧰 Utilidades & Suporte (13)

- `/help [comando]` — Mostra todos os comandos (ou os detalhes de um comando)
- `/novidades` — Mostra as últimas atualizações do bot
- `/ping` — Latência do bot
- `/botinfo` — Informações e estatísticas do bot
- `/avatar [usuario]` — Mostra o avatar
- `/userinfo [usuario]` — Informações de um usuário
- `/serverinfo` — Informações do servidor
- `/say <texto>` — Faz o bot falar *(🔒 Gerenciar Mensagens)*
- `/embed <titulo> <descricao>` — Cria um embed personalizado *(🔒 Gerenciar Mensagens)*
- `/ticket` — Envia o painel de atendimento/denúncia *(🔒 Gerenciar Servidor)*
- `/painel-sugestao` — Envia o painel interativo de sugestões *(🔒 Gerenciar Servidor)*
- `/sugerir <ideia>` — Envia uma sugestão
- `/denuncia <mensagem>` — Envia uma denúncia anônima para a staff

## 🧩 Painéis que o `?setup` configura sozinho

| Painel | Canal | Comando manual |
|---|---|---|
| ✅ Verificação (libera o cargo Membro) | ✅・verificação | `/setverify` |
| 📖 Regras | 📖・regras | — |
| 🎫 Tickets (dúvida e denúncia) | 🎫・abrir-ticket | `/ticket` |
| 💡 Sugestões | 💡・sugestões | `/painel-sugestao` |
| 🏷️ Cargos de interesse (avisos, eventos, sorteios, gamer, dev, designer) | 🏷️・pegar-cargos | — |
| 🎨 Cargo personalizado (compra com nome e cor) | 🎨・cargo-personalizado | `/painel-cargos` |
| 🛒 Loja e mercado (veículos, casas, VIP, upgrades...) | 🛒・loja | `/loja` |
| 📖 Central de Ajuda | 🤖・comandos-bot | `/help` |
| 📰 Novidades | 📰・novidades | `/novidades` |
| 🧭 Guia do servidor | 🧭・guia-do-servidor | — |

## 🔒 Como o `?setup` deixa o servidor

- `?setup` (ou `?setup completo`): apaga canais e cargos e recria tudo. Pede confirmação por botão e só o dono do servidor ou um Administrador usa.
- `?setup atualizar`: não apaga nada, só completa o que faltar.
- `?setup tickets` e `?setup emojis`: etapas isoladas.
- Quem entra **sem o cargo Membro** vê só ✅・verificação e 📖・regras. O restante aparece depois de clicar em **Verificar-me**.
- **Trava:** durante o setup o servidor fica trancado (ninguém escreve em nenhum canal) e é destrancado no fim, mesmo se o setup falhar. Depois disso, **painéis, regras, guia, loja, novidades, níveis, sugestões e logs ficam trancados para todos**, até para a equipe (só o bot escreve; só quem tem Administrador consegue). Nos anúncios, eventos, sorteios, parcerias e enquetes só a equipe escreve. Os demais canais de texto são trancados para quem não é Membro.
- Cargos pagos na loja (personalizados e VIP) e o canal de backup nunca são apagados. Ao final, o bot envia um backup.
- O setup também **atualiza** as mensagens fixas que já existirem (novidades, guia, ajuda, loja, cargo personalizado, verificação e cargos de interesse).
- No `/help` há uma página nova, **🧩 Painéis & Setup**, e o painel de ajuda fica fixo em 🤖・comandos-bot.
