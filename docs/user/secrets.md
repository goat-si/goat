# Secrets

When an agent needs a secret that only you can provide, GOAT can show a private request in the
thread. Enter the value in the card or decline it. For browser sign-ins and payment cards, check the
site shown on the request before answering. The agent receives a reference for GOAT to use, rather
than the value in chat. A request for a shell command can instead provide a private file that the
agent's commands can read for up to 24 hours.

If a request offers a secret provider, you can select it and enter a reference instead of the
value. GOAT reads the value from that provider when you answer. Login and payment card requests
use their dedicated fields. A request ends when its agent's turn ends.

## Secret providers

Where secret providers are enabled, add a 1Password provider in **Settings → Providers → Secret
providers** for the environment that will use it. Install and sign in to the 1Password `op` CLI
on that environment, then supply the account and a name for the provider. In supported settings,
select that provider and enter a reference such as `op://vault/item/field`.

Removing a provider leaves its settings references intact, but they cannot resolve until you add a
provider with the original provider ID again or choose another source in each affected setting.
The missing ID appears beside the reference; enter it in the optional Provider ID field when adding
the provider. Renaming a provider does not change its ID. Removing the provider does not delete the
secrets in 1Password.
