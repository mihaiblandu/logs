# Traces, Logs și Telemetrie — diferențe

Ghid scurt despre cele trei tipuri de date de observabilitate și cum se leagă între ele.

## Ce este telemetria?

**Telemetria** este termenul general pentru colectarea și transmiterea datelor despre comportamentul unui sistem la distanță. Nu este un tip de date în sine, ci **umbrela** care include:

| Pilon | Ce măsoară | Întrebare la care răspunde |
|-------|------------|----------------------------|
| **Logs** | Evenimente discrete | *Ce s-a întâmplat?* |
| **Metrics** | Valori numerice agregate | *Cât de mult / cât de des?* |
| **Traces** | Fluxul unei cereri prin servicii | *Unde a fost lent sau a eșuat?* |

OpenTelemetry (OTel) este standardul modern care unifică colectarea acestor trei piloni.

---

## Logs (jurnale)

Un **log** este o înregistrare text (sau structurată) a unui eveniment la un moment dat.

**Caracteristici:**
- Evenimente individuale, de obicei cu timestamp, nivel (INFO, ERROR) și mesaj
- Pot conține câmpuri structurate (`message=hello`, `status=500`)
- Ușor de citit de oameni; util pentru debugging și audit

**Exemplu** (din `logs/utils`):

```
INFO echo ok message=hello
ERRO echo failed message=hello status=500
```

**Când folosești logs:** erori, decizii de business, evenimente de securitate, orice „s-a întâmplat X la ora Y”.

---

## Traces (urme / trasee)

Un **trace** urmărește o singură cerere (request) de la început până la sfârșit, prin toate serviciile implicate.

**Caracteristici:**
- Format ierarhic: **trace** → **spans** (pași individuali)
- Fiecare span are durată, serviciu, operație și opțional erori
- Legat de un `trace_id` comun pe tot fluxul distribuit

**Exemplu conceptual** (cerere HTTP):

```
Trace abc123
├── Span: API Gateway     (12 ms)
├── Span: Auth Service    (45 ms)  ← lent aici
└── Span: Database Query  (3 ms)
```

**Când folosești traces:** microservicii, latență, bottleneck-uri, dependențe între servicii.

---

## Telemetrie vs Logs vs Traces

| Aspect | Logs | Traces | Telemetrie |
|--------|------|--------|------------|
| **Nivel** | Tip de date | Tip de date | Concept / sistem complet |
| **Granularitate** | Eveniment singular | Flux complet al unei cereri | Toate tipurile de date |
| **Volum** | Mare (fiecare eveniment) | Mediu (per cerere) | Depinde de ce colectezi |
| **Util principal** | Debugging, audit | Performanță distribuită | Monitorizare end-to-end |
| **Corelare** | Prin `trace_id` în câmpuri | Prin `trace_id` nativ | Leagă logs + traces + metrics |

---

## Cum se leagă în practică

1. O cerere intră în sistem → se creează un **trace** cu `trace_id`.
2. Fiecare serviciu adaugă **spans** în același trace.
3. **Logs**-urile din fiecare serviciu includ același `trace_id`.
4. În Grafana, Jaeger sau Datadog poți sări de la un log la trace-ul complet.

```
[Log]  ERRO echo failed trace_id=abc123
         ↓ (click)
[Trace] abc123 → vede tot lanțul de servicii și unde a eșuat
```

---

## Rezumat

- **Logs** = evenimente punctuale („ce s-a întâmplat”)
- **Traces** = călătoria unei cereri („unde și de ce a durat”)
- **Telemetrie** = tot ce trimiți despre sistem (logs + traces + metrics)

Pentru un server simplu ca `logs/utils`, **logs** sunt suficiente. Când adaugi mai multe servicii sau API-uri în lanț, **traces** devin esențiale. **Telemetria** (de ex. OpenTelemetry) le unifică pe toate.
