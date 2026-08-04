# Chrome Web Store assets

Only upload images generated from the exact extension build being submitted.
The current mock workflow animation in `docs/assets/` may be used on GitHub when
it remains labelled as an illustration, but it is not a substitute for Store
screenshots of the real extension experience.

## Upload set

| File | Size | Status | Evidence shown |
| --- | ---: | --- | --- |
| `01-explicit-consent.png` | 1280×800 | Ready | The real first-install Options page from the exact 1.4.1 candidate ZIP. The Local disclosure opens automatically while Local Relay remains Off, the acknowledgement is unchecked, download access is Off, and no Device ID exists. SHA-256: `4374cbd906f659cb10966db22f9d5526ad89559997cf1a7cd54678d3a463ba60`. |
| `promo-small.png` | 440×280 | Ready; re-verify before upload | Brand-first promotional tile rendered from `promo-small.svg`; no product-status claim, ranking badge, screenshot, or Device ID. |

Chrome permits one to five screenshots and prefers 1280×800. All screenshots
must be square-cornered, full bleed, current, legible when downscaled to
640×400, and free of private browser state. This packet intentionally uses the
minimum one truthful product screenshot instead of fabricating CLI, customer
system, or multi-machine evidence.

## Truthfulness rules

- Use a clean browser profile and synthetic pages only. Never capture the
  owner's everyday profile, private tabs, notification center, bookmarks, or
  account avatar.
- Do not fabricate a connected state or a remote success response in HTML.
- The Northstar page is intentionally synthetic. Keep “Mock internal dashboard
  · no real company data” visible in every image that contains it.
- Do not claim that Browser Relay bypasses authentication or security controls.
  The supported claim is that it uses the browser session the user has already
  opened and explicitly authorized.
- Do not show or partially mask a live Device ID. Replace the whole value with
  a fixed `REDACTED — secret capability` label during capture.
- Keep `docs/assets/browser-relay-mobile-to-office.*` labelled as an illustrated
  workflow; never upload frames from it as evidence of a real multi-machine
  session.

## Visual QA

- Verify dimensions from the PNG header, not Finder metadata.
- Inspect every image at 100% and at 50% scale on both a light and dark desktop.
- Check that text is not clipped and that no consent checkbox appears selected
  before the corresponding disclosure is accepted.
- Run OCR or manually search the screenshots for usernames, emails, tokens,
  Device IDs, localhost profile paths, and private URLs.
- Record the source commit and SHA-256 of each uploaded image in the release
  checklist.

## Manual capture gate

1. Load the exact Store ZIP into a clean current-Chrome profile.
2. Confirm the committed screenshot still matches the exact ZIP and contains
   no private state.
3. Complete Chrome's native Local Network Access Allow, Deny, and revoke flows
   by hand; CDP permission overrides do not grant the extension real loopback
   access and are not acceptable evidence.
4. Re-run Local, Remote, optional-download, and no-daemon smoke against the
   exact ZIP before uploading it.
5. Verify the final 1280×800 screenshot at 100% and 50% scale.
