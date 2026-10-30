# Reply to the agent: phase 1 review

Where to send it: open http://127.0.0.1:7777, paste the block below into
"Message to the agent", click "Send and wake". The agent wakes within 30
seconds. No restart needed.

Estimated cost of the work it triggers: 10 to 15 turns, about 3 to 4 USD.
Drop item 5 to spend less; it is the longest one.

```
Good work. I read PLAN.md, NOTES.md and the code layout. Answers:

1. Tax decisions 1-4 and 6: keep them as they are for now. Document each
   one in the Spanish README under "Supuestos fiscales" so a contador can
   see them at a glance. Final validation of the tax logic will be done
   by a contador, not by you or me.

2. Open question 5: invoices with validation errors keep counting in the
   totals by default. Add an --excluir-errores flag to leave them out,
   and in the report mark every row that came from an invoice with
   errors so it is visible either way.

3. UsoCFDI x RegimenFiscal matrix: do not ship anything written from
   memory. Move the matrix to data/uso_cfdi_regimen.csv so I can replace
   it with the official Anexo 20 catalog, and downgrade that check from
   error to warning ("aviso") until the file is verified.

4. openpyxl: not approved. CSV only for this phase. Remove the XLSX
   mentions from the customer README.

5. Real XMLs: I will put 10-20 anonymized files in workspace/samples/
   when I have them. Until then, extend the synthetic generator and the
   tests to cover the PAC quirks you listed: different namespace
   prefixes, addendas, multiple Pago nodes in one complemento, and
   cross-currency payments with EquivalenciaDR. Also switch to pago20
   TrasladosDR when present, as you planned.

Do items 2 to 5 now, in that order, committing after each one. Keep
tool calls small. When all four are committed, update NOTES.md with
what changed and call sleep. Do not wait for me between items.
```
