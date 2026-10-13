# EHR Outbound Sync: Research and Directional Design

> **Status**: Research and directional design. Not scheduled, not built.
> **Date**: 2026-10-12
> **Scope**: One-way delivery of records from a Civic OS instance into an Electronic Health Record (EHR) system. Nothing flows back except delivery acknowledgements.
> **Builds on**: `docs/notes/THIRD_PARTY_SYNC_DESIGN.md` (generic sync patterns; this note covers the health-specific parts), `docs/notes/DOCUMENT_TEMPLATE_DESIGN.md` (PDF generation), `docs/notes/SCHEDULED_JOBS_DESIGN.md`.
> **Worked example**: a community blood-pressure self-monitoring program, where non-clinical staff and participants record readings and the participant's own clinician should see them.

---

## Summary

1. **"Is it HL7?" Partly.** HL7 International publishes three generations of standards (v2 messages, CDA documents, FHIR APIs). Picking "HL7" decides very little. What decides the work is **which EHR is receiving, how it wants the data to land, and whether the receiving organization will set up a connection**.
2. **Federal rules require EHRs to support reading data out, not writing data in.** ONC certification requires FHIR read APIs (US Core, SMART on FHIR, Bulk export). Writing into the chart is optional for the vendor and has to be enabled by each health system. Inbound one-way sync therefore depends on a partner agreeing to it. It is not a standard capability you can rely on.
3. **The data format is the easy part.** The real cost is in four places: patient matching (putting a reading in the wrong chart is a safety event), consent, the receiving health system's security review and interface queue, and clinical responsibility (someone has to act when a crisis-range reading lands in a chart).
4. **Recommended Civic OS shape:** a transactional **outbox** of canonical **FHIR R4 JSON** built in SQL, with **pluggable transports** at the edge (FHIR REST, HL7 v2, Direct, SFTP). The outbox doubles as the disclosure log. Transports for v2 and MLLP should come from an integration engine rather than be written in Go.

---

## 1. The standards landscape

| Standard | Body | Shape | Typical transport | Where it's used today | Viable for writing *into* an EHR? |
|---|---|---|---|---|---|
| **HL7 v2.x** (2.5.1 most common) | HL7 | Pipe-delimited messages (`MSH`, `PID`, `OBR`, `OBX`) | MLLP over VPN, or SFTP files | Inside hospitals: ADT, lab results, device and vitals feeds into flowsheets | **Yes, the most common way in.** Interface teams know `ORU^R01`, which lands as discrete flowsheet or result values. Needs the hospital's interface engine and team. |
| **CDA / C-CDA** R2.1 | HL7 | XML clinical documents | Direct Secure Messaging, IHE XDS/XCA via HIEs | Transitions of care, referrals, HIE document query | **Yes, as a document.** Lands in an inbox, usually not as discrete values. See the HTI-5 risk in §6. |
| **FHIR R4** (US Core 6.1 baseline since 2026-01-01) | HL7 | REST + JSON resources (`Patient`, `Observation`) | HTTPS, SMART Backend Services auth | Patient-access apps, population export, newer vendor integrations | **Sometimes.** Certified EHRs must support FHIR *read*. *Write* (for example `Observation.create` for vitals) is vendor-optional and enabled per organization. |
| **FHIR IGs for this domain** | HL7 | Profiles on FHIR | as FHIR | CardX Hypertension Management (STU1): self-measured BP, average BP, associated heart rate. US Core has guidance on writing vital signs. Gravity SDOH Clinical Care: social-care referrals. | These say how the data should be shaped. They don't open a connection. |
| **SMART Health Links** | HL7/SMART | Encrypted FHIR bundle behind a URL or QR code | Patient carries it | CMS "Kill the Clipboard" pledgers accept inbound patient data this way. First CMS Aligned Networks went live April 2026. | **Patient-mediated.** Doesn't depend on any institution. Receiver support is still uneven and the spec is still settling. |
| **IHE XDS / XCA / PIX/PDQ** | IHE | Document registries and patient lookup | SOAP | HIEs, Carequality, eHealth Exchange | Through an HIE only. |
| **DirectTrust (Direct)** | DirectTrust | Secure email (S/MIME) carrying C-CDA or PDF | SMTP via a HISP | Faxing replacement between providers and to CBOs | **Yes.** Most certified EHRs have a Direct inbox. |
| **TEFCA** | ASTP/ONC + Sequoia (RCE) | Governance framework over QHINs | IHE and FHIR | National query-based exchange. Purposes: treatment, payment, operations, public health, government benefits, individual access. | Governance, not a format. Non-HIPAA entities can join as sub-participants but must follow the Security Rule. |
| **X12** (837/835/270) | X12 | EDI | Clearinghouse | Claims and eligibility | Only relevant if someone bills for services. |

**How to read the table:** v2, C-CDA and FHIR are formats. Direct, MLLP and REST are transports. TEFCA and HIEs are trust frameworks. A working integration needs one of each, plus an agreement with the receiver.

---

## 2. Read is mandated, write is negotiated

- **ONC certification** (§170.315(g)(10)) requires FHIR R4 read APIs with SMART authorization and Bulk Data export. CMS rules add payer APIs. None of these require an EHR to accept third-party writes.
- **FHIR write exists but is gated.** US Core publishes guidance for writing vital signs (single-reading create is required, batch is optional, and patient-originated data may be kept separate, for example on its own flowsheet). Whether a server supports it shows up in its `CapabilityStatement`. Epic exposes vitals write, but each customer organization must activate the app and map the LOINC codes to its own flowsheet rows. Row IDs differ per organization.
- **Epic Aura** is Epic's one-connection route for device and diagnostics vendors. So far its public partners are cardiac monitoring companies (iRhythm, Boston Scientific, Philips). It's a vendor partnership, not something a program can sign up for on its own.
- **Conclusion:** every inbound channel except Direct and SMART Health Links needs a named partner at the receiving organization who will do some work. The proposal should name that partner, or else scope the integration as discovery.

---

## 3. Channels into an EHR

| # | Channel | Who must act at the receiver | Where data lands | Lead time | Main cost driver | Scales to many providers? |
|---|---|---|---|---|---|---|
| **C0** | **Participant-held summary**: PDF plus optional SMART Health Link QR | Nobody. The clinician chooses to look. | Scanned media, or imported if the receiver's SHL reader supports it | Days | PDF generation (Document Templates, not built). The SHL manifest server. | **Yes.** Works with any EHR. |
| **C1** | **Direct message**: C-CDA or PDF to the clinician's Direct address | Clinician or practice accepts it into the chart | Inbox, then attached as a document | Weeks | HISP contract (historically about $50–75 per address per year). C-CDA generation. Directory lookup. | **Yes**, if each clinician has a Direct address |
| **C2** | **HL7 v2 `ORU^R01`** via the partner's interface engine | Partner interface team, security review, VPN or SFTP | Discrete flowsheet or result values | 1–4+ months (their queue) | Partner time. VPN at the hosting site. Patient matching. | No. One build per receiving organization. |
| **C3** | **FHIR `Observation.create`** (US Core BP / CardX SMBP) | Partner enables the app and maps flowsheet rows | Discrete flowsheet values | 1–6 months | App registration and activation per organization. SMART Backend Services keys. | No. One activation per organization. |
| **C4** | **State HIE** (in Michigan, MiHIN as the state-designated entity) | HIE onboarding; may need a new HIE use case | Routed to attributed providers (MiHIN's care-relationship service; verify current offering) | 6–18 months | Use-case sponsorship (the state agency), participation agreement | **Yes**, once live. Matches statewide expansion. |
| **C5** | **Commercial intermediary** (Redox, Health Gorilla, Particle; Metriport is open source) | Usually the health system must already be a customer | Depends on the intermediary's connection | 1–3 months | Per-connection and per-message fees | Partly |
| **—** | **Population or registry feed** (CSV or FHIR Bulk NDJSON over SFTP) | Data team, not the chart | Data warehouse or registry, not the chart | Weeks | Low | N/A. This is reporting, not EHR sync. |

**Fan-out problem.** Programs like the worked example serve people whose primary care is spread across many organizations and EHRs. C2 and C3 cost one integration per organization. Only C0, C1 and C4 scale to "whoever the participant's doctor is."

**What the receiver needs to tell you before a channel can be chosen:**

1. Which organizations and EHRs (vendor and version), and who owns the relationship.
2. Should the data land as discrete values (flowsheet), a document, or a registry feed?
3. How will patients be matched: MRN captured at enrollment, demographic match by the receiver, or a manual review queue?
4. What is the clinical responsibility for incoming readings: who reviews them, how fast, and what about crisis values?
5. What legal basis and consent apply: is the sender a covered entity, does it disclose for treatment, or does it need a participant authorization?
6. How often: per reading, daily, or end of program?

---

## 4. Proposed Civic OS architecture

The same principle as Document Templates and Notifications applies: **the integrator assembles data in SQL (SECURITY INVOKER, RLS applies), and the framework handles delivery.**

```
 domain tables (e.g. bp_readings)
        │  property-change trigger / status transition / scheduled batch
        ▼
 ┌───────────────────────────────────────────────┐
 │ integration.outbound_messages  (outbox)       │  ← same txn as the source write
 │  source (table,id) · destination · consent    │
 │  canonical FHIR R4 JSON (built by SQL mapper) │
 │  idempotency key · status · attempts          │
 │  external_id · ack · error                    │
 └───────────────────────────────────────────────┘
        │  River job inserted in the same txn
        ▼
 ┌───────────────────────────────────────────────┐
 │ consolidated worker: clinical_export_<kind>   │
 │  fhir_rest   → POST / conditional create      │
 │  direct_hisp → render C-CDA/PDF, HISP REST API│
 │  sftp_file   → NDJSON / CSV batch             │
 │  v2_engine   → hand off to integration engine │──► Open Integration Engine
 └───────────────────────────────────────────────┘     (MLLP, v2 ACKs, partner mapping)
        │ ack / external id / error class
        ▼
 outbox row updated → admin monitor, retry, dead-letter queue
```

### 4.1 Canonical model: FHIR R4 JSON built in SQL

- An integrator writes one mapper function per exported entity (`fhir_observation_from_bp_reading(id) RETURNS jsonb`) using `jsonb_build_object`. Postgres produces FHIR JSON easily, and the mapping is reviewable SQL inside the instance's migrations.
- **Why FHIR is the internal format even when the wire format is v2 or C-CDA:** it maps one-to-one onto rows. The relevant IGs (US Core, CardX) define the codes. v2 `OBX` segments and C-CDA vital-sign entries can be derived from it mechanically at the edge. One mapping per entity, many transports.
- BP reading mapping: `Observation`, category `vital-signs`, code LOINC `85354-9` (BP panel), components `8480-6` systolic and `8462-4` diastolic in `mm[Hg]`, `effectiveDateTime`, `performer` = Patient for self-measured readings (CardX SMBP profile). A program-wide average uses the CardX Average SMBP profile with `derivedFrom` pointing at the individual readings.
- `Observation.identifier` = `{system: "https://<instance-host>/fhir/id/<table>", value: <row id>}`. The same identifier is used for every send of that row. It is the idempotency key and the correction anchor.

### 4.2 Outbox and destinations (sketch)

- `integration.destinations`: `kind` (`fhir_rest | direct_hisp | sftp_file | v2_engine | shl`), endpoint, auth mode (SMART Backend Services JWT, API key, SFTP key), per-destination options (flowsheet mapping, Direct address source). Secrets live in the instance config store, never in metadata rows.
- `integration.patient_links`: `(person_id, destination_id, external_patient_id, assigning_authority, verified_at, verified_by)`. **Nothing is sent without a verified link** (C0 is the exception, since the participant carries it). Demographics travel with each message so the receiver can check the match.
- `integration.outbound_messages`: the outbox (columns as in the diagram). It is append-only. A correction is a new row that references the earlier one.
- Consent: an explicit consent record (person, destination or "my clinician", data scope, granted/revoked). The enqueue trigger checks it, and revoking consent cancels pending rows. Revoking does not recall data already delivered, and the UI must say so.

### 4.3 Delivery semantics

| Concern | FHIR REST | HL7 v2 | Direct |
|---|---|---|---|
| Idempotency | Conditional create `If-None-Exist: identifier=<system>|<value>` | Stable `MSH-10` per outbox row; stable filler ID in `OBR-3` per source row | Stable `Message-ID` |
| Correction / void | `PUT` with `status = entered-in-error` (or the corrected value) against the stored `external_id` | `OBX-11` = `C` (corrected) / `W` (posted in error) | Send a corrected document that replaces the original (`relatesTo`) |
| Ordering | Don't send a correction until the original has an `external_id`. Per-person sequence column. | Same | Same |
| Errors | 4xx → dead-letter + admin queue; 5xx and timeouts → River backoff | `AE`/`AR` ACK codes → dead-letter; no ACK → retry | Delivery-status notification (MDN) failure → dead-letter |

The Go worker already classifies errors as retryable or permanent for Keycloak and Telnyx. Reuse that.

### 4.4 Build vs integrate at the edge

| Transport | Recommendation | Why |
|---|---|---|
| FHIR REST, HISP REST APIs, SFTP | **Go worker job kinds** | Same pattern as the Telnyx and Keycloak clients. Small surface. |
| HL7 v2 over MLLP | **Open Integration Engine** (MPL-2.0 fork of Mirth Connect 4.5.2), fed from the outbox | MLLP framing, ACK handling, v2 escaping and per-partner quirks are what interface teams already use Mirth-family tools for. Health-system analysts can read OIE channels. Mirth itself has been commercial-only since 4.6 (2025), so use the fork, or BridgeLink. |
| Many organizations at once | **HIE (C4)** rather than our own fan-out | Routing by care relationship is the HIE's job and requires its trust agreements. |

`THIRD_PARTY_SYNC_DESIGN.md` recommends Redpanda Connect for generic sync. It is a reasonable alternative for the FHIR REST leg. For v2 and MLLP specifically, a healthcare engine fits better.

### 4.5 Pull alternative

Civic OS could instead be a source that others pull from: a FHIR Bulk-style NDJSON export written to S3 on a schedule, with presigned URLs. That suits registries and state agencies, which pull data. EHRs rarely pull from outside sources except through HIEs, so this is secondary for EHR sync.

---

## 5. Phasing

| Phase | Delivers | Depends on | Size |
|---|---|---|---|
| **P0** | Participant-held summary (PDF), generated on demand | Document Templates (design only today) | M |
| **P1** | Outbox, destinations, patient links, consent gate, admin monitor; `sftp_file` transport | Instance config store for secrets | M |
| **P2** | `fhir_rest` transport with SMART Backend Services; mapper conventions doc; CardX/US Core BP mapping as the reference example | A partner with write enabled | M |
| **P3** | `direct_hisp` transport (C-CDA generation and a HISP contract) or `v2_engine` hand-off to OIE, whichever the first partner needs | Partner choice | M–L |
| **P4** | SMART Health Link issuance (encrypted bundle, manifest endpoint, QR code) | Receiver adoption; the SHL spec settling | M |

Sizes are relative. In every case the critical path is the receiver's schedule, not Civic OS work.

---

## 6. Compliance and governance notes

- **Who is covered decides the paperwork, not the data type.** A disclosure from a HIPAA covered entity to a provider for treatment is permitted without patient authorization (45 CFR 164.506). A non-covered program still needs an authorization under its contract and as good practice. Either way, the health system will run a security review before it opens an interface.
- **Interface support means seeing PHI.** Debugging a rejected message means reading its payload. A support model where Civic OS never sees production data stops working the moment we troubleshoot a live feed. Decide in the contract who runs the interface and whether Civic OS signs a BAA.
- **The outbox is the disclosure log.** It records who sent what to whom, when, and under which consent. That covers the accounting-of-disclosures requirement for covered-entity deployments with no extra work.
- **Clinical responsibility.** Pushing readings into a chart creates an expectation that someone acts on them. Receivers often decline unsolicited home readings for this reason. Crisis-range handling has to be agreed before any channel goes live, and discrete feeds should go to a designated "remote/home BP" flowsheet row that is kept separate from clinic vitals.
- **Regulatory drift.** HTI-5 (proposed 2025-12-29, comments closed 2026-02-27; no final rule found as of this note) would narrow the transitions-of-care criterion to C-CDA *receipt* and remove the reconciliation/incorporation criterion, both effective 2027-01-01. Receiving Direct/C-CDA survives, but discrete import of C-CDA data becomes less likely. Its stated direction is FHIR-first. Re-check before committing to C1.
- **No PHI in push or SMS payloads** (no BAA is available from browser push services), same as the existing HIPAA posture for notifications.

---

## 7. Open questions

1. Is EHR delivery a funded deliverable or a later phase? If funded, which named organization commits interface time?
2. Discrete values or a document: what does the receiving clinician actually want?
3. Are home readings, staff-observed readings, or both in scope? They map to different profiles and flowsheet rows.
4. Should outbox tables live in an `integration` schema managed by core (as `payments` and `accounting` are), or in metadata?
5. Should Civic OS host SMART Health Link manifests, or hand the bundle to a third-party SHL service?

---

## Sources

- HL7 US Core, Writing Vital Signs: https://build.fhir.org/ig/HL7/US-Core/branches/master/writing-vital-signs.html
- HL7 CardX Hypertension Management IG: https://build.fhir.org/ig/HL7/CardX-HTN-MNG/
- ASTP/ONC HTI-5 proposed rule: https://healthit.gov/regulations/hti-rules/hti-5-proposed-rule/
- AHA comments on HTI-5 (C-CDA concerns): https://www.aha.org/lettercomment/2026-02-27-aha-comments-astponc-health-care-technology-interoperability-proposed-rule
- McDermott on HTI-5: https://www.mcdermottlaw.com/insights/astps-hti-5-relaxes-certification-criteria-while-tightening-information-blocking-exceptions/
- TEFCA overview and exchange purposes: https://healthit.gov/tefca
- TEFCA updates, Feb 2026: https://healthit.gov/wp-content/uploads/2026/02/2026-02-19_TEFCA_Updates_Presentation_508.pdf
- CMS Kill the Clipboard provider guide: https://www.cms.gov/initiatives/health-technology-ecosystem/overview/health-tech-ecosystem-categories/provider-kill-clipboard-guide
- Flexpa, CMS Aligned Network production (April 2026): https://www.flexpa.com/blog/flexpa-reaches-production-kill-the-clipboard
- NextGen, Mirth Connect licensing change: https://www.nextgen.com/blog/industry-news/a-new-era-for-mirth-connect-by-nextgen-healthcare
- Open Integration Engine: https://openintegrationengine.org
- ONC, Direct Secure Messaging basics: https://healthit.gov/sites/default/files/page/2020-07/0720_Direct%20Secure%20Messaging%20Basics.pdf
- TMA on Direct messaging costs (2021): https://www.texmed.org/TexasMedicineDetail.aspx?id=58347
- iRhythm on Epic Aura: https://investors.irhythmtech.com/news/news-details/2024/iRhythm-collaborates-with-Epic-to-streamline-access-to-Zio-service-and-drive-more-seamless-connectivity-between-clinicians-and-patients/default.aspx
- MDHHS SDOH hub pilots (CBO-to-MiHIN onboarding precedent): https://www.michigan.gov/mdhhs/inside-mdhhs/legislationpolicy/2022-2024-social-determinants-of-health-strategy/sdoh-hubs/sdoh-hub-pilots
