# Teorie: logging, observabilitate, ELK / OpenSearch, OpenTelemetry

Note de teorie pentru proiectul ăsta (șase servicii în șase limbaje, un singur standard de loguri).
Fiecare fișier se poate citi separat; ordinea de mai jos merge de la „ce e un log" la „cum e făcut aici".

**Pe scurt, într-un singur fișier:** [rezumat.md](rezumat.md).

<!-- cuprins -->
## Cuprins

- **[1. Ce este un log](01-logs.md)**
  - [1.1 Log nestructurat vs. log structurat](01-logs.md#11-log-nestructurat-vs-log-structurat)
  - [1.2 Anatomia unui log](01-logs.md#12-anatomia-unui-log)
  - [1.3 Niveluri de severitate (modelul log4j)](01-logs.md#13-niveluri-de-severitate-modelul-log4j)
  - [1.4 Ce NU se loghează](01-logs.md#14-ce-nu-se-loghează)
  - [1.5 Bune practici](01-logs.md#15-bune-practici)
  - [1.6 Unde scrie aplicația logurile](01-logs.md#16-unde-scrie-aplicația-logurile)
- **[2. Centralizarea logurilor](02-centralizare.md)**
  - [2.1 Problema: de ce nu ajung logurile locale](02-centralizare.md#21-problema-de-ce-nu-ajung-logurile-locale)
  - [2.2 Ce înseamnă centralizare](02-centralizare.md#22-ce-înseamnă-centralizare)
  - [2.3 Arhitectura de referință](02-centralizare.md#23-arhitectura-de-referință)
  - [2.4 Modele de colectare](02-centralizare.md#24-modele-de-colectare)
  - [2.5 Normalizarea: un standard pentru toate serviciile](02-centralizare.md#25-normalizarea-un-standard-pentru-toate-serviciile)
  - [2.6 Corelarea](02-centralizare.md#26-corelarea)
  - [2.7 Securitate și date personale (GDPR)](02-centralizare.md#27-securitate-și-date-personale-gdpr)
  - [2.8 Retenție și costuri](02-centralizare.md#28-retenție-și-costuri)
  - [2.9 Fiabilitate](02-centralizare.md#29-fiabilitate)
  - [2.10 Alertare și utilizare](02-centralizare.md#210-alertare-și-utilizare)
  - [2.11 Pași de implementare (checklist)](02-centralizare.md#211-pași-de-implementare-checklist)
  - [2.12 Anti-pattern-uri](02-centralizare.md#212-anti-pattern-uri)
  - [2.13 Mai multe domenii și instanțe (SFS, MF, CTIF, Vamă, …)](02-centralizare.md#213-mai-multe-domenii-și-instanțe-sfs-mf-ctif-vamă-)
  - [2.14 În proiect](02-centralizare.md#214-în-proiect)
- **[3. Logs, traces, metrics — cei trei piloni](03-logs-traces-metrics.md)**
  - [3.1 Logs](03-logs-traces-metrics.md#31-logs)
  - [3.2 Traces](03-logs-traces-metrics.md#32-traces)
  - [3.3 Metrics](03-logs-traces-metrics.md#33-metrics)
  - [3.4 Cum se leagă: corelarea](03-logs-traces-metrics.md#34-cum-se-leagă-corelarea)
  - [3.5 Context comun: baggage](03-logs-traces-metrics.md#35-context-comun-baggage)
- **[4. Unde se propagă și se salvează Trace ID-ul](04-propagarea-trace-id.md)**
  - [4.1 În header-ele HTTP / mesaje de rețea (propagarea contextului)](04-propagarea-trace-id.md#41-în-header-ele-http--mesaje-de-rețea-propagarea-contextului)
  - [4.2 În loguri (MDC / context de logare)](04-propagarea-trace-id.md#42-în-loguri-mdc--context-de-logare)
  - [4.3 În răspunsul HTTP către client (recomandat)](04-propagarea-trace-id.md#43-în-răspunsul-http-către-client-recomandat)
  - [4.4 În baza de date / audit log (unde e cazul)](04-propagarea-trace-id.md#44-în-baza-de-date--audit-log-unde-e-cazul)
  - [4.5 Cum circulă un Trace ID într-o cerere](04-propagarea-trace-id.md#45-cum-circulă-un-trace-id-într-o-cerere)
  - [4.6 Sfat practic](04-propagarea-trace-id.md#46-sfat-practic)
- **[5. OpenTelemetry](05-opentelemetry.md)**
  - [5.1 Componente](05-opentelemetry.md#51-componente)
  - [5.2 Resursa (Resource)](05-opentelemetry.md#52-resursa-resource)
  - [5.3 Modelul de date al unui log (Logs Data Model)](05-opentelemetry.md#53-modelul-de-date-al-unui-log-logs-data-model)
  - [5.4 Collectorul](05-opentelemetry.md#54-collectorul)
  - [5.5 Propagarea contextului](05-opentelemetry.md#55-propagarea-contextului)
  - [5.6 Convenții semantice (semconv)](05-opentelemetry.md#56-convenții-semantice-semconv)
  - [5.7 Cum e folosit în proiect](05-opentelemetry.md#57-cum-e-folosit-în-proiect)
- **[6. ELK și OpenSearch](06-elk-opensearch.md)**
  - [6.1 ELK / Elastic Stack](06-elk-opensearch.md#61-elk--elastic-stack)
  - [6.2 OpenSearch](06-elk-opensearch.md#62-opensearch)
  - [6.3 Concepte de bază](06-elk-opensearch.md#63-concepte-de-bază)
  - [6.4 Implementare pas cu pas](06-elk-opensearch.md#64-implementare-pas-cu-pas)
  - [6.5 Mărime și performanță (reguli orientative)](06-elk-opensearch.md#65-mărime-și-performanță-reguli-orientative)
  - [6.6 Alternative](06-elk-opensearch.md#66-alternative)
- **[7. Implementarea din proiect](07-implementare-in-proiect.md)**
  - [7.1 Fluxul](07-implementare-in-proiect.md#71-fluxul)
  - [7.2 Formatul unui log](07-implementare-in-proiect.md#72-formatul-unui-log)
  - [7.3 Cine face ce](07-implementare-in-proiect.md#73-cine-face-ce)
  - [7.4 Cum folosești](07-implementare-in-proiect.md#74-cum-folosești)
  - [7.5 Testele](07-implementare-in-proiect.md#75-testele)
  - [7.6 De reținut pentru alt proiect](07-implementare-in-proiect.md#76-de-reținut-pentru-alt-proiect)
<!-- /cuprins -->

Vezi și [`traces-logs-telemetrie.md`](https://github.com/mihaiblandu/logs/blob/main/traces-logs-telemetrie.md)
(diferențele dintre traces, logs și telemetrie, pe scurt) și
[`README.md`](https://github.com/mihaiblandu/logs#readme) (cum pornești proiectul).

## Pe scurt

- **Logul** spune *ce s-a întâmplat*; **trace-ul** spune *pe unde a trecut cererea și cât a durat*;
  **metrica** spune *cât de des / cât de mult*, agregat în timp.
- Cu zeci de servicii și containere care apar și dispar, logurile **trebuie** strânse într-un singur loc,
  altfel nu le poți căuta, corela sau păstra.
- **OpenTelemetry** e standardul deschis pentru a produce și transporta toate trei, independent de backend.
- **ELK / OpenSearch** e locul unde logurile se stochează, se indexează și se caută.
- Cheia corelării: același `trace_id` în log și în trace.
