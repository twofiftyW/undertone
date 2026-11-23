# Undertone accounts

Undertone uses a Cloudflare Worker and a D1 database. GitHub sign-in identifies
the account. New accounts redeem one invite, including the owner's first account.
Once registered, sign in on another device without entering another invite.

## Set up the service

1. Register a dedicated [GitHub OAuth app](https://github.com/settings/developers)
   and enable **Device Flow** in its settings. Enter the Worker URL for the
   homepage and required callback fields. Undertone uses the device code flow.
2. From this folder, install dependencies with Node.js 22.18+ and pnpm, sign in
   to Cloudflare, and create the database.

```sh
pnpm install --frozen-lockfile
pnpm exec cf auth login
pnpm exec cf d1 create --name undertone-accounts
```

Set `UNDERTONE_D1_ID` to the database UUID from that command,
`UNDERTONE_GITHUB_CLIENT_ID` to the GitHub OAuth app's client ID, and
`UNDERTONE_OWNER_GITHUB_ID` to the numeric GitHub ID of the owner. The owner
can look up their ID with `gh api user --jq .id`.

```sh
pnpm exec cf d1 migrations apply "$UNDERTONE_D1_ID"
pnpm exec cf deploy
```

Set `accountOrigin` in [web/account-config.js](../../web/account-config.js)
to the resulting HTTPS `workers.dev` origin before packaging the apps. Use
the same origin for Linux, Windows, Android, and iOS. The packaged app
opens GitHub in the system browser to authorize sign-in.

## Register the owner

Generate the first code using your Cloudflare access. This invite is reserved
for the configured GitHub owner and expires after seven days.

```sh
UNDERTONE_BOOTSTRAP_CODE="$(openssl rand -hex 16)"
UNDERTONE_BOOTSTRAP_HASH="$(printf '%s' "$UNDERTONE_BOOTSTRAP_CODE" | openssl dgst -sha256 -r | cut -d ' ' -f1)"
pnpm exec cf d1 raw "$UNDERTONE_D1_ID" \
  --sql 'INSERT INTO invites (hash, expires_at, reserved_for) VALUES (?, unixepoch() + 604800, ?)' \
  --params "$UNDERTONE_BOOTSTRAP_HASH" "$UNDERTONE_OWNER_GITHUB_ID" &&
  printf '%s\n' "$UNDERTONE_BOOTSTRAP_CODE"
unset UNDERTONE_BOOTSTRAP_CODE UNDERTONE_BOOTSTRAP_HASH
```

Enter the bootstrap code in **Settings → Account** and sign in with the
owner's GitHub account. Use **Generate invite code** to create further
single-use codes. Only the owner has this action. The database stores the
hash of each invite and session token.

## Library sync

The first account signed in on a device starts with its existing library.
Later changes sync after edits, when the app reconnects or comes to the
foreground, and once a minute while visible. Playlist order, repeated tracks,
likes, and followed artists are included. Imported tracks can appear on other
devices as metadata. Downloaded or imported audio files, local paths, playback
history, and volume are device-specific.

New accounts need their own invite. Signing out stops sync and returns to
the device's signed-out library. Each account's pending local edits are
available when that account signs back in on the device.

Run `pnpm test` to exercise the Worker with local D1 and a simulated
GitHub identity provider. The test covers invite ownership and redemption,
session isolation, concurrent writes, and merging library edits.
