# Brains & Bacchanal — Content Policy

The project owner may also play the game, so production content must stay away from normal development work.

## Content Statuses

### EXAMPLE
Visible explanatory content for docs/demos.

Never becomes production.

### TEST
Fake content for development, automated tests and QA.

Never becomes production.

### PRODUCTION_SEALED
Approved real game content hidden from spoiler-safe roles until required in live play.

### PRODUCTION_REVEALED
Real content already played/revealed.

### RETIRED
Content removed from rotation.

## Non-Negotiable Rule

`EXAMPLE` and `TEST` can never become `PRODUCTION_SEALED`.

## Repo Rule

Normal Git repository must not contain:
- real unrevealed production questions,
- accepted production answers,
- sealed Family Feud board labels,
- future challenge secrets.

Development fixtures belong in:

```text
content/test-only/
```

## Production Content Flow

```text
CREATE / IMPORT
      ↓
VALIDATE
      ↓
QUALITY REVIEW
      ↓
SEAL + VERSION + HASH
      ↓
PACK ASSIGNMENT
      ↓
LIVE RELEASE ONLY WHEN REQUIRED
      ↓
REVEALED / RETIRED
```

## Family Feud Survey

Current custom survey:
- 47 responses.

Those responses are accepted for those custom boards.

Additional boards may use approved larger external datasets.

Store source metadata such as:
- `CUSTOM_SURVEY`
- `EXTERNAL_DATASET`

Normalize:
- case,
- spelling variants,
- singular/plural,
- clear synonyms,
- duplicates.

Do not expose sealed answers in spoiler-safe admin views.

## Runtime

The game server should release only the active production content needed for the current game state.

Player browsers must never receive future/unrevealed answer payloads.
