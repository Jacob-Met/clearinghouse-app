# CLEARINGHOUSE

Change the plan. Keep everyone's promises visible.

Clearinghouse is a group tab for people buying something together: tickets, a trip, a shared gift. It keeps each person's exact share, each person's agreement and each PayPal payment tied to one numbered version of the plan, so when the plan changes nobody is held to a version they never saw.

It is for the person who ends up organising: the one who fronts the tickets and then chases everyone.

## What it does

- Shows the group total and every share to the cent, one colour per person.
- Lets the organiser propose a change. Each change becomes a new revision; earlier approvals become history.
- Records optional spending limits and shows who is over theirs.
- Records each person's agreement against one exact revision.
- Creates one PayPal order per person only after everyone has agreed, and captures each payment on an explicit confirmation.
- When a plan changes after someone has paid, works out additional amounts or returns against what was already captured.

## How it uses AI

The organiser can describe a change in plain words ("keep everyone within their limit and share the extra equally"). A language model reads the request and returns a structured reading: which sharing rule, which purchases and people stay unchanged. Clearinghouse validates that reading, shows it, lets the organiser correct it, and computes the split itself in exact cents. The result is only copied into the draft when the organiser chooses to. The model never approves anything and never moves money.

Any OpenAI-compatible chat completions endpoint works. It was built and tested with `qwen2.5:7b` served by Ollama.

## How it uses PayPal

Payments run on the PayPal REST API in **Sandbox**:

- OAuth 2.0 client credentials (`/v1/oauth2/token`), kept on the server only
- Orders v2: create one order per payer (`POST /v2/checkout/orders`), read its status (`GET /v2/checkout/orders/{id}`), and capture after the payer approves (`POST /v2/checkout/orders/{id}/capture`)
- Payments v2: refund part or all of an earlier capture when a changed plan lowers someone's share (`POST /v2/payments/captures/{id}/refund`)

The endpoint is fixed to the Sandbox host in code.

## Run it

Requires Node.js 20 or newer. There are no npm dependencies and no build step.

```sh
npm start
# open http://127.0.0.1:4173
```

That is enough to build plans, record agreements and try the ticket example. To use PayPal Sandbox and a model:

```sh
ollama pull qwen2.5:7b

export PAYPAL_SANDBOX_CLIENT_ID="your sandbox client id"
export PAYPAL_SANDBOX_CLIENT_SECRET="your sandbox client secret"
export PAYPAL_SANDBOX_RETURN_URL="http://127.0.0.1:4173/"
export PAYPAL_SANDBOX_CANCEL_URL="http://127.0.0.1:4173/"
export CLEARINGHOUSE_AI_BASE_URL="http://127.0.0.1:11434/v1"
export CLEARINGHOUSE_AI_MODEL="qwen2.5:7b"
# export CLEARINGHOUSE_AI_API_KEY="only if your endpoint needs one"

npm start
```

`PORT` changes the port. Create Sandbox credentials at <https://developer.paypal.com/dashboard/applications/sandbox>. Pay as a Sandbox personal account or with PayPal's Sandbox test cards.

## A two-minute walkthrough

1. Choose **Try the ticket example**: three people, $220.
2. **Propose a change**, lower one person's spending limit, and open **Explore another split**.
3. Type what should change and choose **Explore with AI**. Check the model's reading, then **Copy AI split into my editable draft** and **Create next revision**.
4. Under **Limits & approvals**, record each person's agreement.
5. In **Settle your shares**, create the payer links, open one and pay in the PayPal Sandbox.
6. Back on the tab, **Refresh payments** and **Capture**. The tab shows what is retained and what is left to collect.

Choose **Keep on this browser** if you want the plan to survive leaving the page; otherwise save it to a file.

## Tests

```sh
npm test
```

A few replay tests are skipped because they read recorded model responses that are not part of this repository.

## License

MIT. See [LICENSE](LICENSE). The bundled typeface has its own licence in `app/BRICOLAGE-LICENSE.txt`.
