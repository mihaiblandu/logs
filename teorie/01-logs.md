# 1. Ce este un log

<!-- cuprins -->
**Cuprins**

- [1.1 Log nestructurat vs. log structurat](#11-log-nestructurat-vs-log-structurat)
- [1.2 Anatomia unui log](#12-anatomia-unui-log)
- [1.3 Niveluri de severitate (modelul log4j)](#13-niveluri-de-severitate-modelul-log4j)
- [1.4 Ce NU se loghează](#14-ce-nu-se-loghează)
- [1.5 Bune practici](#15-bune-practici)
- [1.6 Unde scrie aplicația logurile](#16-unde-scrie-aplicația-logurile)
<!-- /cuprins -->

Un **log** (jurnal) este o înregistrare cu marcaj de timp a unui **eveniment** petrecut într-o aplicație:
o cerere primită, o eroare, un job terminat, o autentificare eșuată.

Un log răspunde la întrebarea **„ce s-a întâmplat, când și unde?"**. Spre deosebire de o metrică (un număr
agregat) sau de un trace (structura unei cereri), logul păstrează **detaliul unui singur eveniment**.

## 1.1 Log nestructurat vs. log structurat

**Nestructurat** — o linie de text, făcută pentru ochi:

```
2026-10-11 19:25:50 INFO  api.views - downstream call finished status=200 url=http://localhost:5050
```

Ca să afli `status` trebuie să parsezi textul cu regex (Grok în Logstash). Formatul diferă de la limbaj la
limbaj și se strică la prima schimbare de mesaj.

**Structurat** — un document cu câmpuri, făcut pentru mașini (și citibil de oameni):

```json
{
  "timestamp": "2026-10-11T19:25:50.37347Z",
  "level": "INFO",
  "logger": "api.views",
  "service": "django-otel-api",
  "environment": "local",
  "message": "request completed",
  "trace_id": "7a5d280974c77232622d8caf7797aef3",
  "span_id": "6511974e39b6d35c",
  "context": { "userId": "johndoe", "ipAddress": "::1" },
  "request": { "method": "GET", "url": "/api/v1/users" },
  "response": { "statusCode": 200 }
}
```

Când cererea eșuează, același document, cu `level` și detaliile în `response` (nu un câmp separat
`error` / `stack_trace` — stack-ul e pe span, în Jaeger):

```json
{
  "timestamp": "2026-10-11T19:25:51.102Z",
  "level": "ERROR",
  "logger": "api.views",
  "service": "django-otel-api",
  "environment": "local",
  "message": "request completed",
  "trace_id": "7a5d280974c77232622d8caf7797aef3",
  "span_id": "6511974e39b6d35c",
  "context": { "userId": "johndoe", "ipAddress": "::1" },
  "request": { "method": "GET", "url": "/echo" },
  "response": { "statusCode": 500, "body": { "error": "internal error" } }
  // cand este o eroare, se adauga in response corpul erorii care are ca si cheie error si valoarea este mesajul de eșec formatat in json 
  "error": { "message": "internal error", "stack_trace": "..." }
  
}
```

4xx → `WARN` (ex. 401, 404); 5xx → `ERROR`. Un log al aplicației pentru aceeași eroare păstrează
câmpurile proprii în `tags` (`{ "echo.message": "x" }`), tot cu același `trace_id`.

Avantaje: poți filtra direct (`response.statusCode >= 500`, `level:ERROR`), agrega (câte erori pe
serviciu), corela (`trace_id`) — fără parsare. **Regula de bază: logurile se scriu structurat.**
Cheile fără valoare se omit (`tags` doar dacă logul are câmpuri proprii; `request`/`response` doar
pe „request completed").

## 1.2 Anatomia unui log

| Câmp | Rol | Exemplu |
|------|-----|---------|
| timestamp | când (UTC, ISO 8601, precizie sub-secundă) | `2026-10-11T19:25:50.373Z` |
| level / severitate | cât de grav | `INFO`, `ERROR` |
| logger | cine a scris (clasă, modul) — `%c` în log4j | `com.example.otel.EchoController` |
| service / environment | din ce aplicație și mediu | `go-otel-api`, `local` |
| message | ce s-a întâmplat, scurt și stabil | `request completed` |
| trace_id / span_id | legătura cu trace-ul cererii | `7a5d…`, `6511…` |
| context | cine (utilizator, IP) | `{ "userId": "1", "ipAddress": "::1" }` |
| request | metoda și URL-ul (doar pe „request completed") | `{ "method": "GET", "url": "/echo" }` |
| response | status + corp mic; la eroare, mesajul de eșec | `{ "statusCode": 500, "body": { "error": "internal error" } }` |
| tags | câmpuri proprii, opțional | `{ "echo.message": "x" }` |

**Mesajul trebuie să fie constant** („request completed"), iar valorile variabile merg în câmpuri. Așa
poți număra evenimentele de același tip și poți căuta după valori.

`request` și `response` nu țin user-agent, header-e, request id sau durată: acelea sunt deja în trace.
Corpurile, dacă există, sunt JSON mic (în proiect, ≤ 4 KB).

## 1.3 Niveluri de severitate (modelul log4j)

| Nivel | Când | Exemplu |
|-------|------|---------|
| `TRACE` | detaliu extrem, doar la depanare | fiecare pas dintr-un algoritm |
| `DEBUG` | informație pentru dezvoltatori | „processed message, 23 ms" |
| `INFO` | evenimente normale, importante | „request completed", „login ok" |
| `WARN` | ceva neașteptat, dar aplicația merge | 401, retry, timeout recuperat |
| `ERROR` | o operație a eșuat | 500, excepție netratată, dependență căzută |
| `FATAL` | aplicația nu mai poate continua | nu se poate conecta la baza de date la pornire |

Fiecare limbaj are propriile nume (`Information` în .NET, `warning` în PHP/Python, `info` în pino).
Un standard comun le aduce la aceleași nume — în proiectul ăsta, collectorul mapează după
`severity_number` (1–24 în OpenTelemetry) pe numele log4j.

`TRACE` și `DEBUG` sunt pentru dezvoltare, local (consolă). **Nu ajung în stocarea centrală**: collectorul le
aruncă, deci în Elasticsearch / OpenSearch există doar `INFO`, `WARN`, `ERROR`, `FATAL`.

## 1.4 Ce NU se loghează

- **secrete**: parole, tokenuri JWT, chei API, `Authorization`, cookie-uri de sesiune
- **date personale inutile** (GDPR): CNP, carduri, adrese complete; e-mailul doar dacă e nevoie reală
- **corpuri mari** de cereri/răspunsuri: Elasticsearch nu le indexează bine (eșec de indexare) și
  indexarea e scumpă; dacă da, doar JSON mic, cu secretele mascate (`"password": "******"`)
- **date redundante**: ce se află deja în trace (durata, user agent, request id, header-e) sau e identic
  pe toate logurile

## 1.5 Bune practici

1. Structurat (JSON / model de date OpenTelemetry), nu text liber.
2. Un singur standard de câmpuri pentru toate serviciile, indiferent de limbaj.
3. Timp în UTC, ISO 8601.
4. `trace_id` / `span_id` pe orice log scris în timpul unei cereri.
5. Un log „request completed" per cerere (metodă, URL, status) — vezi *access log*.
6. Mesaje constante, valori în câmpuri.
7. Niveluri folosite consecvent; `ERROR` doar pentru eșecuri reale (altfel alertele devin zgomot).
8. Fără secrete și fără zgomot de framework.
9. Logul pleacă din aplicație fără să o blocheze: buffer + trimitere asincronă către un collector,
   nu scriere directă în stocare.

## 1.6 Unde scrie aplicația logurile

| Destinație | Cum ajung la stocare | Observații |
|------------|----------------------|------------|
| fișier | un agent citește fișierul (Filebeat, Fluent Bit) | clasic pe VM-uri; rotație de fișiere |
| stdout | runtime-ul de containere le preia; un agent le citește | standardul în Docker/Kubernetes (12-factor) |
| direct prin rețea (OTLP) | SDK-ul OpenTelemetry trimite la un collector | fără parsare, cu `trace_id` pus automat — **varianta din proiect** |

Aplicația nu scrie în Elasticsearch. Collectorul e buffer-ul: primește OTLP, filtrează, normalizează,
apoi exportă. Așa aplicația nu se blochează dacă stocarea e lentă sau căzută.

<!-- nav -->
---
[Cuprins](README.md) · [2. Centralizarea logurilor →](02-centralizare.md)
<!-- /nav -->
