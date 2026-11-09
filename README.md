# Comb

**BongoHive's internal finance paper trail.** Comb replaces three Excel workbooks (Expense Submission, Procurement form, Staff Advance & Retirement) with one place to request, approve, evidence and seal every transaction.

> Every kwacha gets a cell. A cell is filled with approvals and evidence, then sealed.

## What it is, and what it is not

Comb does one narrow job: everything that happens **before** a transaction reaches the books.

| Tool | Its job | Comb's relationship to it |
|---|---|---|
| **Xero** | Accounting, bank feeds, reports, tax | Comb never keeps the books. It exports paid bills as a CSV for Xero. |
| **ClickUp** | Tasks and project work | Comb does not manage tasks. Quotes move out of ClickUp and sit on the record they support. |
| **Bank, Airtel, MTN** | Moving money | Comb never sends money. Finance pays as usual, then records the reference. |
| **Payroll** | Salaries | Out of scope. |

The niche is what general tools do badly here: the advance-to-retirement cycle, kwacha quote thresholds, mobile money references, and a donor-ready audit pack.

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run demo     # sample data, role switcher, http://localhost:4300
npm start        # real data, real passwords
npm test         # automated tests
```

`npm start` prints a one-time password for the finance lead on first run. Add people and create their passwords in **Admin**. If the finance lead is locked out: `npm run reset-password seiko.mwenya`.

To switch on AI document reading, copy `.env.example` to `.env` and add an `ANTHROPIC_API_KEY`. Without a key everything works and people type the details by hand.

## What replaced what

| Old | In Comb |
|---|---|
| Monthly tabs, Summary, Reference Data | Register, Reports, Admin |
| Purchase Requisition | Procurement request |
| Quote 1 to 3, Quote Analysis | Quotes step, with side-by-side comparison |
| Purchase Order, GRN, Invoice, Receipt tabs | Generated documents and attached evidence |
| Payment Voucher (two versions) | One voucher, numbered automatically |
| Checklist | The progress cells on every request |
| Advance Request, Retirement Form | The advance flow, plus the Advances tracker |

Every document prints or saves as a PDF, and **Full audit pack** bundles a whole transaction.

## The three flows

- **Expense:** draft → manager → finance → final approval → payment → evidence check → sealed
- **Staff advance:** draft → manager → finance → final approval → payment → payee confirms → retirement → finance check → approval → settle balance → sealed
- **Procurement:** draft → manager → finance → quotes → check → authorise → PO → goods received → three-way match → final approval → payment → evidence check → sealed

## Controls

- Nobody approves their own request, and nobody signs twice within one approval gate.
- Sign-offs record the signed-in person and the time. They never change afterwards.
- Amounts must be real numbers. Blanks are refused, never treated as zero.
- The selected quote feeds the PO, GRN and voucher, including VAT, extras and every line.
- A voucher cannot pay more than the value of what was received.
- Sealed records and the audit trail are locked in the database itself. A fingerprint of each sealed record shows if it was ever altered outside the app.
- Flags: possible split purchases, reused files, duplicate invoices, budget overruns, weak justifications, overdue advances.

## Where AI is used

AI **reads and drafts**. It never approves, pays or moves a request.

1. Reads receipts, invoices and quotes, and prefills the form for a person to confirm.
2. Drafts the value-for-money justification from the quote figures.

If AI is unavailable or fails, the upload is kept and the person types the details. Only the uploaded document or quote figures are sent to the Claude API, and that is worth confirming against Zambia's Data Protection Act before switching it on.

## Decisions for finance before go-live

These are working defaults, all changeable in **Admin**.

1. **Retirement deadline:** the old forms said both 5 and 7 working days. Comb uses 5, counted from the end of the activity.
2. **Thresholds:** up to K10,000 one quote; to K20,000 two; above K20,000 three; above K100,000 open tender. Exactly K20,000 needs two.
3. **Expense limit:** expenses above K10,000 must go through procurement. This is a new rule inferred from the thresholds.
4. **Blocking new advances** while one is overdue. Also a new rule, and it can be switched off.
5. **Three-person approval.** The old vouchers had one person as both preparer and checker. Comb needs a reviewer, finance and a final approver, all different, so it relies on two directors and the finance lead. Set department leads in Admin to spread the load.
6. **Exchange rates** are placeholders until finance confirms them in Admin.
7. **Electronic approvals:** confirm that auditors and each donor accept them.
8. **Staff list:** taken from Reference Data, plus the finance lead. The hidden sheet had other names that may be former staff, and they were not imported.

## Before real use

Comb runs on one computer until it is hosted. Before real money goes through it:

- **Host it** behind HTTPS on a server the organisation controls. Set `HOST` and `TRUST_PROXY`.
- **Back up** the `data/` folder daily. It holds the database and all uploaded evidence, including staff payment details, and it is not encrypted by Comb.
- **Test the Xero CSV** with a small batch. The columns follow Xero's bill import from memory and need checking against your own Xero template, including the tax type.
- **Add email or WhatsApp notifications** if wanted. Today people see tasks on their home page, and there is a manual WhatsApp nudge link.
- **Public holidays** are not counted in working days yet.
- Run it alongside the spreadsheets on one project for a month first.

## Layout

```
src/rules.js      money and policy rules, no database or AI
src/workflow.js   stages, who may act, separation of duties, sealing
src/flags.js      review flags
src/ai.js         Claude document reading and drafting
src/app.js        web routes
src/views/        pages and printable documents
seed/             reference data and the 22 imported requests
test/             automated tests
brand/            logo files
```
