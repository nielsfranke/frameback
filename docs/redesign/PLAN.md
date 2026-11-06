# ViTransfer Redesign – Umsetzungsplan (v3)

Stand: 06.11.2026 · v3 mit Entscheidungen von Niels · Prototyp: `http://staging-host:4173`

> **Entscheidungen (06.11.2026):**
> 1. Fork mit Feature-Flags und kleinen Commits auf `main`
> 2. Freigabe zum Start mit `ANY` (eine Person reicht), `ALL` kommt später
> 3. **Ordner dienen nur der Organisation im Studio. Geteilt und freigegeben werden ausschließlich Projekte.** Für einen Kunden mit mehreren Projekten gibt es das bestehende Kundenportal. Ordner-Shares (`ShareLink`, früher S3) entfallen.
> 4. Kunden-Ordner aus `ClientCompany` vorschlagen, darin Jahres-Unterordner nach den vorhandenen Projektjahren
> 5. Staging nur im LAN bzw. über WireGuard, **kein Tailscale**. HTTPS über Caddys interne Zertifizierungsstelle auf `https://staging-host:4326` (das MCP vertraut ihr per `SSL_CERT_FILE`). Produktiv läuft der Fork unter `https://review.example.com`.
> 6. Sitzungen beim Umstieg: Neuanmeldung (Variante B)
> 7. Sprachen nur noch `de` und `en`, `nl` wird entfernt

> **Änderungen gegenüber v1:**
> - Freigabe-Override für Admins und das MCP
> - „Aktuell“ = neueste *fertig verarbeitete* Version
> - durchgängiger Autorisierungskontext für Shares
> - Sperre für ausgehende Nachrichten *vor* dem ersten Start im Staging
> - Staging ohne Kollisionen bei den Containernamen und mit HTTPS
> - Redis-Inventur
> - echte Funktionstests für Links
> - Rollback-Regel
> - Schärfungen im Datenmodell
> - Lieferung in vertikalen Schritten, MVP zuerst
> - kleine Commits hinter Feature-Flags statt langem Branch
> - Aufwandsschätzung

## 0. Ausgangslage

| Punkt | Befund |
|---|---|
| Code | `~/coding/vitransfer` ist ein **Fork** von `MansiVisuals/ViTransfer` (Remote `upstream`). Eigene Änderungen gibt es noch keine. |
| Live-Instanz | `~/vitransfer`, Image `mansivisuals/vitransfer:latest`, Port **4324**, Postgres **16**, Redis 7. Uploads 10,3 GB, Datenbank 68 MB. |
| Abhängige Clients | `resolve-studio-mcp` (`vitransfer.py`). Es akzeptiert **nur HTTPS**, auch im LAN (`server_origin()`). |
| Tests | Im Repo gibt es keine. |
| Sprachen | `de`, `en`, `nl` |

### Fork-Strategie
- **Ein eigener Fork, aber kein langlebiger `redesign`-Branch.** Kleine, fachlich geschlossene Commits auf `main`, Neues hinter **Feature-Flags** (`FEATURE_NEW_SHARE`, `FEATURE_FOLDERS`, …). Jeder Stand ist baubar und deploybar.
- Die Logik liegt in **zentralen Diensten** statt verteilt in Routen:
  - `policy.ts`: wer darf was mit welcher Ressource
  - `review.ts`: Zustandsmaschine der Freigabe
  - `outbound.ts`: einziger Weg für E-Mail, Push und Webhooks
- „Nur ergänzend“ gilt für **Schema-Migrationen**, nicht für die Semantik. Autorisierung, Upload-Lebenszyklus, Löschen und Benachrichtigungen ändern wir bewusst. Das sind genau die Stellen, an denen Merges von upstream geprüft werden müssen.
- Upstream: wöchentlicher Merge mit Prüfung auf Sicherheitsrelevanz (auch bei UI-Fixes). Bei Sicherheitsmeldungen von upstream gibt es eine Eil-Routine außerhalb des Wochenrhythmus. **Verantwortlich: Niels.** Images werden gepinnt (`vitransfer:<sha>`), nicht `:latest`.
- Vertragstests in CI (Forgejo Actions): MCP-Kompatibilität, Links, Autorisierungsmatrix.

## 1. Ziele und Nicht-Ziele

**Ziele**
1. Die fünf Kundenprobleme lösen.
2. Kunden- und Studio-Ansicht neu nach dem Prototyp.
3. Ordner mit Unterordnern zur Organisation im Studio (nicht teilbar). Projekt-Shares mit Inhaltswahl: Videos, Fotos oder beides.
4. Freigabe-Modell „Zur Freigabe senden“.
5. Resolve: Upload, Kommentare als Marker, Status „erledigt“.
6. Paralleler Betrieb und Umstieg. **Alle Daten und alle Share-URLs bleiben erhalten.** Aktive Sitzungen dürfen eine Neuanmeldung erfordern (siehe 8.4).

**Nicht-Ziele (vorerst):** Neubau von Worker, Transcoding, Speicher oder Auth. Kundenkonten. Panel direkt in Resolve.

## 2. Leitlinien

- **Der Server entscheidet.** Jede Anfrage auf Medien, Assets, ZIP, Kommentare, Alben und Entscheidungen läuft durch `policy.ts` mit einem **Autorisierungskontext** (siehe 3.5). Was das UI ausblendet, ist kein Schutz.
- **Eine Wahrheit für die Freigabe:** `review.ts` ist die Zustandsmaschine. `Video.approved`, `approvedAt` und `Project.status` werden daraus *in derselben Transaktion abgeleitet*, nie direkt gesetzt.
- **Kompatibilitätsvertrag** für das MCP (siehe 6.1), mit Tests abgesichert.
- **Secrets (korrigiert in S0):** Nur `ENCRYPTION_KEY` muss identisch sein. Damit sind die Share-Passwörter in der Datenbank verschlüsselt, geprüft per Entschlüsselungstest. `JWT_SECRET`, `JWT_REFRESH_SECRET` und `SHARE_TOKEN_SECRET` signieren nur kurzlebige Tokens. Sie werden im Staging **und beim Umstieg neu erzeugt**. Grund: Die Sperrliste widerrufener Tokens liegt in Redis (`blacklist:user:*`). Mit geleertem Redis und alten Secrets würden widerrufene, noch nicht abgelaufene Tokens wieder gültig. Neue Secrets erzwingen die beschlossene Neuanmeldung ohnehin.
- **Bestehende Shares werden nicht offener.** `authMode` inklusive `BOTH`, Gastrechte, `photoOnlyShare`, `hideFeedback`, Download- und Upload-Einstellungen bleiben pro Projekt exakt erhalten.

## 3. Datenmodell (Schema nur ergänzend, Enums statt freier Strings)

### 3.1 Ordner
```prisma
model Folder {
  id              String   @id @default(cuid())
  name            String
  parentId        String?
  parent          Folder?  @relation("FolderTree", fields: [parentId], references: [id], onDelete: Restrict)
  children        Folder[] @relation("FolderTree")
  clientCompanyId String?                                   // Kunden-Ordner = gesetzt (kein separates isClient)
  clientCompany   ClientCompany? @relation(fields: [clientCompanyId], references: [id], onDelete: SetNull)
  sortOrder       Int      @default(0)
  projects        Project[]
  shareLinks      ShareLink[]
  @@index([parentId])
}
// Project: + folderId String? @relation(onDelete: SetNull)
```
- Beim Verschieben wird die Zeile des Ordners gesperrt (`SELECT … FOR UPDATE`), der Zyklus geprüft und die **Tiefe des ganzen Unterbaums** (maximal 8). Das alles läuft in einer Transaktion.
- Ordner haben **keine Auswirkung auf Rechte**. Verschieben ändert nie, wer was sieht.
- **Vorschlag beim ersten Aufruf** (Dialog „Struktur übernehmen“, nichts passiert automatisch):
  - je `ClientCompany` ein Kunden-Ordner
  - darin Jahres-Unterordner nach dem Erstellungsjahr der Projekte (nur Jahre, die es gibt)
  - Projekte ohne Kunde kommen nach „Ohne Kunde / <Jahr>“

  Vorschau als Baum mit Anzahl. Einzelne Zweige lassen sich abwählen, und der Vorschlag kann rückgängig gemacht werden (Ordner wieder entfernen, `folderId` auf null).
- Neue Projekte: Wird bei einem Projekt ein Kunde gewählt, schlägt der Dialog den Ordner „<Kunde> / <aktuelles Jahr>“ vor und legt ihn bei Bedarf an.

### 3.2 Video-Gruppen
```prisma
model VideoGroup {
  id        String  @id @default(cuid())
  projectId String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name      String
  sortOrder Int     @default(0)
  videos    Video[]
  reviewRequests ReviewRequest[]
  @@unique([projectId, name])
}
// Video: + groupId String? (FK, gleiche projectId per Check im Service), + versionNote String?
```
- Rückfüllung je `(projectId, name)`. **Doppelte Versionsnummern führen zum Abbruch** mit Bericht. Erst nach der Bereinigung wird `@@unique([groupId, version])` erzwungen und `groupId` auf NOT NULL gesetzt.
- Versionsnummern werden atomar vergeben (Sperre auf die Gruppe). Alle alten Pfade zum Anlegen und Umbenennen (Admin-Upload, `POST /api/videos`, Umbenennen) pflegen die Gruppe mit. `Video.name` wird synchron gehalten, für das MCP.
- **„Aktuelle Version“ = höchste Version der Gruppe mit `status = READY`.** Laufende Uploads, Verarbeitungen oder Fehler sind nie „aktuell“.

### 3.3 Freigabe
```prisma
enum ReviewState    { DRAFT IN_REVIEW CHANGES_REQUESTED APPROVED }
enum ReviewOutcome  { APPROVED CHANGES_REQUESTED WITHDRAWN SUPERSEDED }
enum DecisionKind   { APPROVE REQUEST_CHANGES REVOKE ADMIN_OVERRIDE }
enum ApprovalRule   { ANY ALL }

// Video: + reviewState ReviewState @default(DRAFT)

model ReviewRequest {
  id            String   @id @default(cuid())
  groupId       String
  videoId       String               // die konkrete Version
  requestedById String?              // null = historisch/migriert
  requestedAt   DateTime @default(now())
  rule          ApprovalRule @default(ANY)
  approvers     ReviewApprover[]     // bei ALL eingefroren
  closedAt      DateTime?
  outcome       ReviewOutcome?
  decisions     ReviewDecision[]
  // partieller Unique-Index (SQL-Migration): höchstens eine offene Runde pro Gruppe
  //   CREATE UNIQUE INDEX ON "ReviewRequest"("groupId") WHERE "closedAt" IS NULL;
}
model ReviewApprover { id String @id @default(cuid()); requestId String; name String; email String? }
model ReviewDecision {
  id             String   @id @default(cuid())
  requestId      String?               // null nur bei ADMIN_OVERRIDE ohne Runde
  request        ReviewRequest? @relation(fields: [requestId], references: [id])
  videoId        String
  kind           DecisionKind
  actorName      String
  verifiedEmail  String?               // nur aus erfolgreicher E-Mail-Code-Prüfung
  viewerKeyHash  String?
  adminUserId    String?
  approverId     String?               // Zuordnung bei ALL
  note           String?
  idempotencyKey String   @unique
  ip             String?
  createdAt      DateTime @default(now())
  comments       ReviewDecisionComment[] // relationale Liste übermittelter Kommentare (+ Snapshot des Texts)
}
```
**Regeln (`review.ts`, alles in einer Transaktion):**
- *Kunde* (Share): `APPROVE` und `REQUEST_CHANGES` nur, wenn die Version aktuell ist (siehe 3.2), eine offene Runde existiert, der Share die Aktion erlaubt und gegebenenfalls `requireVerifiedApproval` erfüllt ist. Mit Idempotenzschlüssel gegen Doppelklicks.
- *Bei `ALL`* braucht es eine Entscheidung je eingefrorenem Freigeber. Ein Browser- oder Gerätewechsel erzeugt keine zusätzlichen Stimmen. Die Zuordnung zum Freigeber erfolgt über die verifizierte E-Mail **oder** eine bestätigte Auswahl „Ich bin …“ mit Protokoll.
- `REQUEST_CHANGES` schließt die Runde sofort (keine widersprüchlichen Stimmen).
- `REVOKE` durch den Kunden: Er kann seine eigene Freigabe zurückziehen, solange die Version noch aktuell ist. Das Studio wird benachrichtigt.
- **Admin-Override** (`PATCH /api/videos/:id {approved}`, MCP, Admin-UI): Funktioniert für **jede** Version, auch ältere, mehrere und `all_versions`. Es wird als `ADMIN_OVERRIDE` protokolliert, ohne Benachrichtigung (wie heute), und ist wiederholbar und idempotent. `approved=false` setzt den Zustand auf `DRAFT` und schließt eine offene Runde mit `WITHDRAWN`.
- **Ablösen erst bei `READY`:** Eine offene Runde der Vorgängerversion wird erst geschlossen (`SUPERSEDED`), wenn die neue Version **fertig verarbeitet** ist, atomar mit dem Wechsel der aktuellen Version. Ein abgebrochener oder gelöschter Upload hat keine fachliche Wirkung. *Während* Upload und Verarbeitung bleibt die laufende Runde der Vorgängerversion entscheidbar, das Studio sieht einen Hinweis.
- „Projekt freigegeben“ = alle Gruppen haben eine aktuelle Version im Zustand `APPROVED`. `approvedVideoId` wird nur noch für Altlesepfade mitgepflegt (zuletzt freigegebene Version) und ist **deprecated**.
- Migration: `approved=true` wird zu `APPROVED` plus einer historischen `ReviewDecision` (Art `ADMIN_OVERRIDE`, `actorName="Migration"`, keine erfundene Person).

### 3.4 Kommentare
```prisma
// Comment: +
editedAt      DateTime?
deletedAt     DateTime?
deletedBy     String?               // "client" | adminUserId
authorKeyHash String?
verifiedEmail String?               // nur aus E-Mail-Code-Sitzung, nie aus dem Request-Body
resolvedAt    DateTime?
resolvedById  String?
resolvedVia   String?               // "admin" | "resolve"
frame         Int?                  // Start-Frame in der Datei
frameEnd      Int?
fpsNum        Int?                  // rationale Bildrate, z. B. 30000/1001
fpsDen        Int?
// Comment.parent bleibt onDelete: Cascade (physisch löschen nur noch per Admin-"endgültig löschen")
```
- **Soft-Delete überall:** Kunden-Löschen, Admin-Löschen (die bestehende `DELETE /api/comments/:id` wird auf Soft-Delete umgestellt) und alle Lesepfade (Share, Admin, `GET /api/projects/:id`, Benachrichtigungen, Exporte). Gelöschte Kommentare mit Antworten bleiben als Platzhalter stehen. Wiederherstellen per `POST …/restore` für den Autor oder einen Admin.
- **Besitznachweis (Browser-Kennung):**
  - Cookie `vt_viewer`: hostgebunden, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, 1 Jahr, 32 Byte Zufall, *serverseitig erzeugt* (wird nie aus einem Request übernommen, Schutz gegen Fixierung).
  - Mutationen verlangen **zusätzlich**: einen gültigen Share-Zugang, eine Ressource innerhalb des Share-Bereichs, eine erlaubte Aktion und eine Origin/CSRF-Prüfung.
  - Alternativ gilt: `verifiedEmail` der Sitzung = `comment.verifiedEmail`. Ein bestehendes `authorEmail` ist **kein** Nachweis (frei eingebbar).
- Der Elternkommentar muss zum selben Video gehören (Prüfung). Anhänge werden nur vollständig hochgeladen und **exklusiv** beansprucht (`UPDATE … WHERE commentId IS NULL AND uploadCompletedAt IS NOT NULL`). Der Kommentar wird in derselben Transaktion angelegt.

### 3.5 Shares (nur Projekte)

**Entscheidung v3:** Keine Ordner-Shares. Ein Share-Link gehört immer zu genau einem Projekt (`Project.slug`, wie heute). Die bestehenden Einstellungen am Projekt bleiben, ergänzt um:
- `shareContent` (Enum `VIDEOS_AND_PHOTOS | VIDEOS | PHOTOS`). Ersetzt fachlich `photoOnlyShare`, das für alte Lesepfade mitgepflegt wird (`PHOTOS` ⇔ `photoOnlyShare=true`).
- `requireVerifiedApproval Boolean @default(false)`

**Projekte werden wie bisher einzeln per Link verschickt, auf Wunsch ganz ohne Anmeldung (`authMode = NONE`, „Offener Link“).** Das Portal ist ein optionales Zusatzangebot, keine Pflicht. Kunden mit mehreren Projekten *können* das **Kundenportal** nutzen (`/portal`, Anmeldung per E-Mail-Link, zeigt alle Projekte mit dem Kunden als Empfänger). Das Portal bekommt in S2 das neue Design.

Der Autorisierungskontext bleibt sinnvoll, aber einfacher: Das Share-Token enthält das Projekt, einen Rechte-Snapshot (Inhalt, Kommentare, Freigabe, Downloads, Gast) und `viewerKeyHash`. Alle `/api/share/[token]/*`-Endpunkte prüfen über `policy.canAccess`. So wirkt auch `shareContent` serverseitig (keine Video-Streams bei `PHOTOS`).

Datensparsamkeit: Die Share-Route liefert Empfänger-E-Mails nur noch an verifizierte Empfänger, nicht an jeden mit dem Passwort.

<details><summary>Verworfen: Ordner-Shares (v2)</summary>

### 3.5-alt Shares und Autorisierungskontext
```prisma
enum ShareTarget { PROJECT FOLDER }
enum ShareAuth   { NONE PASSWORD OTP BOTH }
model ShareLink {
  id          String      @id @default(cuid())
  token       String      @unique
  targetType  ShareTarget
  projectId   String?
  folderId    String?
  // CHECK (SQL): (targetType='PROJECT' AND projectId IS NOT NULL AND folderId IS NULL) OR (targetType='FOLDER' AND folderId IS NOT NULL AND projectId IS NULL)
  includeVideos     Boolean @default(true)
  includePhotos     Boolean @default(true)
  includeSubfolders Boolean @default(true)
  dynamic           Boolean @default(true)
  members           ShareLinkMember[]      // feste Auswahl bei dynamic=false
  authMode          ShareAuth @default(PASSWORD)
  passwordEnc       String?
  guestMode         Boolean @default(false)
  clientCanApprove  Boolean @default(true)
  requireVerifiedApproval Boolean @default(false)
  downloadPolicy    String  @default("FINAL_AFTER_APPROVAL")
  expiresAt   DateTime?
  revokedAt   DateTime?
}
```
- **Altbestand:** `Project.slug` bleibt **der** Share-Token alter Links, mit den Einstellungen am Projekt wie heute. Die Auflösung prüft zuerst `Project.slug`, dann `ShareLink.token`. Beim Anlegen eines `ShareLink` wird eine Kollision mit *beiden* Namensräumen ausgeschlossen. Ein neuer Token kann einen alten Slug nie verdecken.
- **Autorisierungskontext:** Nach der Anmeldung stellt der Server ein Share-Token aus, das enthält:
  - `shareKind` (LEGACY_PROJECT | LINK)
  - `shareId`
  - Ziel
  - Rechte-Snapshot: Medien, Kommentare, Freigabe, Downloads
  - `viewerKeyHash`
  - Ablauf

  Es gibt **keine** uneingeschränkten Projekt-Tokens aus Ordner-Shares. Alle bestehenden Endpunkte (`/api/share/[token]/*`, Video-Token, Download-All, Kommentare, Alben, Vorschaubilder) prüfen über `policy.canAccess(ctx, resource, action)`.
- **Widerruf und Ablauf** gelten auch für bereits ausgestellte Medien- und Download-Tokens: kurze Laufzeit und eine Prüfung gegen `revokedAt`/`expiresAt` beim Einlösen.
- Datensparsamkeit: Offene Shares liefern keine E-Mail-Adressen der Empfänger aus (heute sehen Nicht-Gäste sie).
- Der Standard für **neue** Shares ist PASSWORD bzw. ein offener Link nach Wahl. Der E-Mail-Code ist optional, passend zu „Kunden ohne Konto“.

</details>

### 3.6 Dateien
- `VideoAsset` + `purpose` (THUMBNAIL, SUBTITLE, LICENSE, PROJECT_FILE, OTHER) + `displayName` + `downloadPolicy`. **Bestehende Assets bleiben `OTHER`** und behalten die heutige Regel. Es gibt keine pauschale Umklassifizierung.
- Original und Vorschauen sind keine Zeilen in `VideoAsset`. Eine **gemeinsame Regelauswertung** `policy.downloadable(ctx, file)` gilt für Original, Vorschau, Assets und ZIP.
- Hinweis: Bei `skipTranscoding` bzw. Wiedergabe des Originals bekommt der Kunde die Originalbytes beim Abspielen. „Download erst nach Freigabe“ ist dann nur eine UI-Regel. Der Admin-Dialog sagt das ausdrücklich.

### 3.7 Umsetzungsstand S1/1 und bewusst offene Punkte (nach Codex-Runde 2)

Umgesetzt in `src/lib/review.ts`, Migration `20261106120256_frameback_review_flow`:
- Gruppen-Lock-Protokoll, Neustart der Transaktion bei Kollision oder Deadlock
- READY plus Ablösen der alten Runde in einer Transaktion
- Exklusivität per partiellem Unique-Index
- `(groupId, version)` eindeutig, `groupId NOT NULL`
- atomares `ensureGroup`
- globaler Idempotenz-Schlüssel mit Abgleich (Fingerprint)
- Umbenennen auf dem geprüften Stand
- Protokoll für alle Aktionen

**Bewusst offen bzw. als Betriebsregel festgelegt:**
- **Nebenwirkungen nach dem Commit** (Clean-Preview-Queue, E-Mails): Schlagen sie fehl, liefert eine Wiederholung `applied=false` und holt sie nicht nach. Upstream hat dieselbe Schwäche. Später kommt eine transaktionale Outbox (S5).
- **Admin-Freigaben über die Share-Seite verschicken weiterhin E-Mails** wie bisher. Der Admin-PATCH (UI, MCP) verschickt nie welche.
- **Rollout:** Die Migration erzwingt `groupId NOT NULL`. Alte Images dürfen deshalb **nie** gegen eine migrierte Datenbank laufen. Ein Rollback heißt Backup zurückspielen, kein Image-Wechsel zurück. Der Umstieg ist ein einziger Image-Wechsel (siehe 8.3).
- **Wiederanlauf einer fehlgeschlagenen Migration:** Wegen `BEGIN/COMMIT` bleibt kein halbes Schema zurück. Ursache beheben (z. B. doppelte Versionsnummern), dann `prisma migrate resolve --rolled-back 20261106120256_frameback_review_flow` und `prisma migrate deploy`.
- **Neue Gruppen während „Projekt zurücknehmen“:** Sie entstehen ohne Freigabe und ohne Runde, das Zurücknehmen betrifft sie daher nicht. Eine Projekt-Sperre ist unnötig.
- **HTTP-Vertragstests** (PATCH mit `{name, approved}`, Flag an/aus, Benachrichtigungen) folgen mit dem MCP-Livetest im Staging.

**Nach S1/2 (Kommentare, Aktionen) bewusst offen** (Codex-Runden 4 und 5):
- **Zustellung von Benachrichtigungen** (Änderungswunsch an das Studio, E-Mail-Abbruch bei Löschung): Sie läuft weiterhin „nach dem Commit, best effort“. Eine Outbox kommt in S5, zusammen mit E-Mail-Vorlagen für „Bitte prüfen“ (Kunde) und „Änderungen angefordert“ (Studio).
- **Gleichzeitiges Bearbeiten desselben Kommentars in zwei Tabs:** Der letzte gewinnt, ein Versionsvergleich ist nicht nötig, weil es nur den eigenen Kommentar betrifft.
- **Produktregel:** Wer Zugriff auf ein Projekt mit Kommentar- bzw. Freigaberecht hat, darf über *alle* Videos dieses Projekts entscheiden. Rechte pro Video gibt es nicht.
- **Startprüfung:** Ist `NEXT_PUBLIC_APP_URL` `https://…`, muss `HTTPS_ENABLED=true` gesetzt sein. Diese Prüfung kommt mit dem ersten Produktions-Deployment (S1-Umstieg), zusammen mit `ALLOWED_ORIGINS`.

## 4. Kundenansicht (nach Prototyp v2)

Wie in v1 beschrieben:
- Bedingte Navigation und Versionsauswahl, „Neu in Version X“ aus `Video.versionNote`
- Schlanke Entscheidungsleiste, auf dem Handy unten fixiert, Willkommensdialog statt Tutorial
- Barrierefreiheit: Fokusfalle, Timeline als Slider, Tabs und Menüs nach ARIA-Muster

Neu:
- Die Zeitstelle eines Kommentars wird als **Frame** erfasst (`requestVideoFrameCallback`, falls verfügbar, sonst `currentTime × fps`, gerundet) und mit rationaler fps gespeichert. Die Toleranz ±1 Frame wird dokumentiert.
- Ohne Feature-Flag läuft weiterhin die alte Share-Seite.

## 5. Studio-Ansicht (nach Prototyp)

Wie in v1. Drag & Drop und die Entscheidungsregel `ALL` kommen erst in einem späteren Schritt.

## 6. API

### 6.1 Kompatibilitätsvertrag
| Endpunkt | Muss erhalten bleiben |
|---|---|
| `/api/auth/device/*`, `/refresh`, `/logout` | Ablauf, rotierende Refresh-Token-Familien (Wiederverwendung widerruft die Sitzung) |
| `GET /api/projects`, `GET /api/projects/:id` | alle heutigen Felder (siehe v1). Gelöschte Kommentare entfallen. Neue Felder nur zusätzlich. |
| `POST /api/videos`, `GET`/`DELETE /api/videos/:id` | Lebenszyklus inklusive „fehlgeschlagener Upload löscht den eigenen UPLOADING-Platzhalter“ |
| `PATCH /api/videos/:id {approved}` | **Admin-Override** für beliebige Versionen, ohne Benachrichtigung, Rücklesen ergibt den gesetzten Wert |
| tus `/api/uploads` | `Location` same-origin, Wiederaufnahme |
| `GET /login` mit `__STORAGE_PROVIDER__` | bis das MCP auf `/api/server-info` umgestellt ist |
| `/share/<slug>`, `/api/share/[token]/*` | Pfade, Slugs, Verhalten pro `authMode` inklusive `BOTH`, Gast, Fotos only |

### 6.2 Neue Endpunkte (`/api/v2`)
Wie in v1, präzisiert:
- `GET /videos/:id/comments?cursor=`: stabiler Cursor über `(updatedAt, id)`. Liefert auch **Löschungen und Wiederherstellungen** (Tombstones), damit Resolve-Marker entfernt bzw. neu gesetzt werden können.
- Kommentar-Antwort mit `frame`, `frameEnd`, `fpsNum/fpsDen` und `timeOrigin` (Datei-Frame 0).
- Entscheidungen: `POST /api/share/[token]/decisions` mit `Idempotency-Key`.

## 7. Resolve-Anbindung
Wie in v1, ergänzt:
- Die Zuordnung der Marker berücksichtigt **Timeline und Version**. Sie läuft über die bestehende `render_binding` und `record_offset`. Für Kommentare einer älteren Version wird nicht gemappt, außer auf ausdrücklichen Wunsch.
- **Mehrere Kommentare auf demselben Frame** werden zu einem Marker zusammengefasst (Notiz listet alle). `customData` enthält eine Liste von IDs.
- **Gelöschte Kommentare** (Tombstones) entfernen ihren Marker, erledigte färben ihn um.
- Das MCP braucht HTTPS. Im Staging läuft es mit `SSL_CERT_FILE` auf das exportierte Root-Zertifikat (siehe 8.1).

## 8. Docker-Parallelbetrieb und Migration

### 8.1 Staging-Stack
- Eigenes Compose-Projekt `~/vitransfer-next`, **ohne `container_name`** (sonst kollidiert es mit den Live-Containern). Eigene Volumes, eigene Netzwerke, Port 4325.
- **Gleiche Major-Versionen wie live** (Postgres 16, Redis 7). Das Upgrade auf PG 18 bzw. Redis 8 erfolgt separat *nach* dem Umstieg.
- App und Worker nutzen dasselbe gepinnte Image `vitransfer:<sha>`.
- HTTPS: Caddy mit interner Zertifizierungsstelle auf `:4326` (`scripts/staging/export-ca.sh` exportiert das Root-Zertifikat), HTTP auf `:4325` für schnelle Browser-Tests. Kein Tailscale.
- **Sperre für ausgehende Nachrichten, bevor die App zum ersten Mal startet (gilt schon in P0):**
  1. **Netzwerk:** App und Worker hängen nur an einem Netzwerk mit `internal: true`. Ausgehend gibt es kein Internet, also kein SMTP, keinen Push und keine Webhooks. Nur Caddy hängt zusätzlich am externen Netz.
  2. **Bereinigung der Daten nach dem Restore, vor dem Start** (Skript):
     - SMTP-Felder in `Settings` leeren
     - `NotificationDestination` deaktivieren
     - `PushSubscription` und `NotificationQueue` leeren
     - `appDomain` auf die Staging-Adresse setzen
     - Erinnerungs-Cron aus
  3. Ab P1 zusätzlich `OUTBOUND_DISABLED=true` in `outbound.ts` (Schutz auf mehreren Ebenen).
  4. Im Prüfbericht: ein Testversand muss scheitern.

### 8.2 Probelauf (`scripts/staging-refresh.sh`, idempotent)
1. Staging-App und Worker stoppen.
2. Konsistenter Dump vom Live-System (`pg_dump` ist transaktionskonsistent). Die Uploads per `rsync`. Für den Probelauf reicht ein „ungefähr konsistenter“ Stand, beim Umstieg gilt 8.3.
3. Restore, Bereinigung (siehe 8.1), `prisma migrate deploy`, Rückfüllung (idempotent, protokolliert, **ohne Benachrichtigungen**, Abbruch bei Konflikten).
4. **Prüfbericht:**
   - IDs, Beziehungen und Speicherpfade alt gegen neu, nicht nur Zeilenzahlen. Jede Datei, auf die ein Datensatz zeigt, existiert.
   - **Alle** Slugs werden ihrem Projekt zugeordnet. Pro `authMode` (NONE, PASSWORD, OTP, BOTH, Gast, Fotos only) wird ein **echter Ablauf** getestet: Anmeldung, Videoliste, Stream-Token, Kommentar lesen, Download-Recht. Ein HTTP 200 auf die HTML-Seite reicht nicht.
   - Ein bekanntes Share-Passwort wird entschlüsselt (Secrets-Check).
   - Der Testversand scheitert (Sperre aktiv).
   - MCP-Vertragstests im Live-Modus gegen Staging (HTTPS).

### 8.3 Umstieg
1. Ankündigung, Zeitfenster.
2. Live-System **schreibgeschützt** schalten:
   - statische Wartungsseite vor die App (Proxy)
   - laufende tus-Uploads abwarten bzw. abbrechen
   - Queue leer laufen lassen
   - Worker und Scheduler stoppen
   - App stoppen
3. Finaler `pg_dump`, `rsync` der Differenz der Uploads, **Redis-Snapshot (RDB)** sichern.
4. Restore, Migration, Rückfüllung, Prüfbericht. **Abbruch, wenn eine Prüfung fehlschlägt** (Live-System wieder starten).
5. **Abnahmefenster ohne Schreibzugriffe:** Der neue Stack läuft hinter der Wartungsseite, nur du testest (Proxy erlaubt nur deine IP oder Tailscale). Bis hier ist ein Rollback trivial.
6. Öffnen: Der Proxy schaltet auf den neuen Stack. `review.example.com` zeigt auf proxy-host, das von dort (vermutlich per WireGuard) auf den DeskMini weiterleitet. Umgestellt wird entweder das Upstream dort, oder der neue Stack übernimmt Port 4324. Die Domain bleibt gleich.
7. **Ab dem ersten Kundenschreibzugriff (Kommentar, Entscheidung, Upload) gibt es keinen Rollback mehr, nur noch Fixes nach vorn.** Der alte Stack und die Volumes bleiben 14 Tage gestoppt als Datensicherung. Ein Backup samt Wiederherstellung wird vorher einmal real getestet.

### 8.4 Redis und Sitzungen
- **Inventur (S0, aus dem Code):** Redis enthält nur kurzlebige oder ersetzbare Zustände:
  - Gerätecode-Login (`device_code:*`)
  - Token-Sperrliste (`blacklist:user:*`)
  - kurzlebige Zugriffs- und Download-Tokens (`video_access:`, `album_access:`, `zip_download:`, `photo_zip:`, `project_upload_dl:`)
  - Dedupe-Schlüssel (`share_access:`, `comment_cancelled:`)
  - Rate-Limits
  - Security-Event-Cache
  - BullMQ-Queues (beim Umstieg leer laufen lassen)

  Dauerhafte Fachdaten liegen nicht in Redis. **Ergebnis: Variante B (Redis leer, neue JWT-Secrets) ist sicher und vollständig.**
- Entscheidung danach:
  - **Variante A:** Den RDB-Snapshot übernehmen, damit bleiben die Sitzungen erhalten.
  - **Variante B:** Kontrolliert neu anmelden. Kunden geben ihr Passwort bzw. ihren Code erneut ein, das MCP meldet sich per Gerätecode neu an.

  B ist einfacher und sauberer, die Share-**URLs** bleiben in beiden Fällen gültig.

## 9. Lieferung in vertikalen Schritten

Jeder Schritt ist ein deploybarer Stand hinter Feature-Flags, wird im Staging geprüft und von Codex gereviewt.

| Schritt | Inhalt | Abnahme | PT* |
|---|---|---|---:|
| **S0 Fundament** | Gepinntes Image, Staging inklusive Sperre und HTTPS, Probelauf-Skript, Redis-Inventur, Testgerüst (Vitest, Playwright), CI-Vertragstests, MCP gegen Staging | Prüfbericht grün, MCP-Suite grün, Testversand scheitert | 6–9 |
| **S1 MVP für Kunden** | `VideoGroup` und „aktuell = neueste READY“, `reviewState` mit `review.ts` (nur `ANY`), Admin-Override, minimaler Dialog „Zur Freigabe senden“ (mit Versionsnotiz), neue Kundenansicht, Kommentare bearbeiten, löschen und wiederherstellen per Browser-Kennung, Soft-Delete überall | Playwright: Version finden, kommentieren, korrigieren, Änderungen anfordern, freigeben, Datei laden (Desktop und Handy); negative Autorisierungstests; MCP grün | 18–28 |
| **S1-Umstieg** | Erster echter Umstieg nach 8.3 mit S1 | Live auf eigenem Image | 3–5 |
| **S2 Studio-Ansicht und Portal** | Projektseite neu, Ordner (`Folder`), Ordnerbaum, Breadcrumbs, Strukturvorschlag Kunde/Jahr, Teilen-Dialog mit `shareContent`, Kundenportal im neuen Design, `nl` entfernen | Projekte in Ordnern verwaltbar, Vorschlag übernehm- und rückgängig machbar, `shareContent` serverseitig wirksam | 10–16 |
| ~~S3 Ordner-Shares~~ | entfällt (Entscheidung v3) | – | – |
| **S4 Resolve** | Frames und rationale fps, Kommentare mit Cursor und Tombstones, `resolved`, MCP-Werkzeuge | Rendern, Upload, Kommentar, Marker, erledigt, Status | 7–12 |
| **S5 Ausbau** | `ALL`-Freigeber, Drag & Drop, Asset-Zwecke, Upgrade PG 18 und Redis 8, alte Felder entfernen | je nach Umfang | 6–11 |

\*PT = Personentage eines erfahrenen Entwicklers mit KI-Unterstützung (Codex-Schätzung, leicht angepasst). **Summe ≈ 50–81 PT** (ohne Ordner-Shares). Der erste Kundennutzen kommt nach S0 + S1 + Umstieg, also nach rund 27–42 PT.

## 10. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Staging verschickt Mails oder Push an Kunden | Internes Netz ohne Internet, Datenbereinigung vor dem Start, `OUTBOUND_DISABLED`, Testversand im Prüfbericht |
| Share gibt mehr frei als eingestellt (z. B. Videos trotz `PHOTOS`) | Zentrales `policy.ts` mit Rechte-Snapshot im Token, Negativtests pro Einstellung |
| Freigabe der falschen Version | „aktuell = neueste READY“, partieller Unique-Index, Transaktion, Idempotenz |
| Abgebrochener Upload entwertet eine Freigaberunde | Ablösung erst bei READY |
| MCP bricht | Vertragstests in CI und gegen Staging, Admin-Override erhalten |
| Merges von upstream werden schwierig | Kleine Commits, zentrale Dienste, Prüfroutine, benannter Verantwortlicher für Sicherheit |
| Kollidierende Container oder Volumes | Staging ohne `container_name`, eigene Namen |
| Sitzungen gehen beim Umstieg verloren | Bewusste Entscheidung A oder B (siehe 8.4), URLs bleiben |
| Rollback nach Kundendaten | Abnahmefenster ohne Schreibzugriffe, danach nur Fixes nach vorn, Backup-Wiederherstellung getestet |
| Kein Testnetz im Bestand | S0 baut Tests vor jedem Umbau |

## 11. Entscheidungen

Alle sieben sind getroffen, siehe den Kasten am Anfang. Offen ist nichts, was S0 blockiert.
