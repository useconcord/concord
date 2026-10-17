# Google sign-in setup guide

This guide is for operators of a Concord server. It covers creating a Google OAuth client, the redirect URI, the two environment variables, how Google sign-in treats existing password accounts, how it works with invitations and sign-up codes, and the errors people may see on the sign-in page.

Google sign-in is optional. Without it, people sign in with email and password.

## 1. Create the OAuth client

In the Google Cloud Console, create an OAuth 2.0 client of type **Web application** (under APIs & Services, Credentials) and configure the consent screen. Add the redirect URI from the next section as an authorized redirect URI. Google's console wording changes over time, so follow Google's current documentation for these steps; they are not defined by Concord.

Concord requests the scopes `openid email profile`.

## 2. Redirect URI

Register exactly this URI in the OAuth client:

```
{CONCORD_PUBLIC_URL}/api/auth/google/callback
```

`CONCORD_PUBLIC_URL` is the address people use to open Concord, for example `https://concord.example.com`. Only its origin (scheme, host and port) is used; any path is dropped. If `CONCORD_PUBLIC_URL` is not set, Concord falls back to `RENDER_EXTERNAL_URL`, and then to `http://127.0.0.1:4400` (the host and port the server listens on). Google rejects the sign-in if the redirect URI Concord sends does not match one registered on the client, so set `CONCORD_PUBLIC_URL` to the real public address before testing.

_Source: `services/api/src/auth-api.ts` (`redirectUri`), `services/api/src/config.ts` (`publicUrl`)._

## 3. Environment variables

| Variable                       | Value                   |
| :----------------------------- | :---------------------- |
| `CONCORD_GOOGLE_CLIENT_ID`     | The OAuth client ID     |
| `CONCORD_GOOGLE_CLIENT_SECRET` | The OAuth client secret |

Set both or neither. If only one is set, the server refuses to start with the error `set both CONCORD_GOOGLE_CLIENT_ID and CONCORD_GOOGLE_CLIENT_SECRET, or neither`.

When both are set, the dashboard shows a Google button: **Continue with Google** on the sign-in page, **Sign up with Google** on the sign-up page, and **Join with Google** or **Continue with Google** on an invitation page. When they are not set, the buttons are hidden and `GET /api/auth/google/start` answers 404 with `Google sign-in is not set up on this server.`

The start route is rate limited per client IP (30 requests per 10 minutes). The sign-in attempt is tracked in a short-lived cookie that expires after 10 minutes.

_Source: `services/api/src/config.ts`, `services/api/src/auth-api.ts` (`/google/start`), `apps/web/src/Auth.tsx` (`Google`)._

## 4. How Google sign-in treats accounts

- **Verified email required.** Google must report the email address as verified. Otherwise sign-in fails with `google_unverified`.
- **First sign-in with a new email.** Concord creates the account. Unless the person is accepting an invitation (see below), it also creates a new workspace named "{first name}'s workspace" and makes the person its owner. In `CONCORD_SIGNUP=code` mode this needs a sign-up code.
- **Returning Google user.** Someone whose Google identity is already linked signs straight in. No sign-up code is needed.
- **Existing password account: not merged.** If an account with the same email already exists and has not been linked to this Google identity, Concord refuses with `google_exists` instead of merging. Nobody proved they own that address when the password account was created, so merging would hand the account to whoever registered it first.

### Connecting Google to an existing account

1. The person signs in with their password.
2. In **Settings**, they click **Connect Google**. The button shows only when Google sign-in is configured and the account has no Google identity yet.
3. They sign in to Google. The Google account must have a verified email equal to the Concord account's email (compared case-insensitively). If it does, the Google identity is linked and the account is marked email-verified.

After that, they can sign in with Google. Errors during this connect flow send the person back to Settings, not the sign-in page.

_Source: `services/api/src/auth.ts` (`googleSignIn`, `linkGoogle`), `apps/web/src/Settings.tsx`._

## 5. Invitations and sign-up codes

### Invitations

An invitation is for one email address. A person can accept it with Google if the Google account's verified email equals the invited address (case-insensitively).

- **New person:** the account is created and added to the inviting workspace. No sign-up code is needed, even in `CONCORD_SIGNUP=code` mode, and no new workspace is created.
- **Invited address already has a password account:** Google sign-in is refused with `google_exists` unless that Google identity is already connected. The invitation page for this case asks the person to sign in with their password to accept. After connecting Google in Settings, they can use Google.
- **Google email differs from the invited address:** the invitation is ignored for that sign-in, and the ordinary sign-up rules apply as if there were no invitation.

### Sign-up codes

`CONCORD_SIGNUP` is `open` (the default) or `code`.

- `open`: anyone can create a workspace, with or without Google.
- `code`: a new account that is not accepting a matching invitation needs a valid sign-up code. On the sign-up page the code is entered first and passed along when the person clicks **Sign up with Google**. A missing, wrong, used or expired code ends in `signup_code`.

An operator creates a code with `pnpm concord signup-code [--note TEXT]`. A code is single-use and, by default, expires after 14 days.

_Source: `services/api/src/auth.ts` (`googleSignIn`, `spendSignupCode`, `createSignupCode`), `services/api/src/config.ts` (`CONCORD_SIGNUP`), `services/api/src/cli.ts`, `apps/web/src/Auth.tsx`._

## 6. Errors on the sign-in page

When Google sign-in fails, Concord redirects to `/#/signin?error=<code>` (or to `/#/settings?error=<code>` when the person was connecting Google), and the dashboard shows the message for the code. An unknown code shows the `google_failed` message.

| Code                | Message shown                                                                                             | When it happens                                                                                                                                                                                                                                                                     |
| :------------------ | :-------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google_exists`     | An account with this email already exists. Sign in with its password, then connect Google under Settings. | The email belongs to an existing account that is not linked to this Google identity. During connect, also when the Google account is already connected to a different Concord account                                                                                               |
| `google_unverified` | Google has not verified that email address, so it cannot be used to sign in.                              | Google did not report the email as verified                                                                                                                                                                                                                                         |
| `google_cancelled`  | Google sign-in was cancelled.                                                                             | Google returned an `error` to the callback, for example when the person declined access                                                                                                                                                                                             |
| `google_mismatch`   | Connect the Google account that uses the same email address as your Concord account.                      | During connect: the Google account's email is unverified or differs from the Concord account's email                                                                                                                                                                                |
| `signup_code`       | New workspaces need a valid sign-up code from the operator of this server.                                | `CONCORD_SIGNUP=code` and no valid code (and no matching invitation)                                                                                                                                                                                                                |
| `google_failed`     | Google sign-in did not complete. Try again.                                                               | Anything else: the 10-minute sign-in cookie is missing or expired, the `state` does not match, the token exchange with Google fails, the returned token has the wrong issuer, audience, nonce or is expired, or an unexpected server error occurs. Details are logged on the server |

_Source: `services/api/src/auth-api.ts` (`/google/callback`), `apps/web/src/Auth.tsx` (`GOOGLE_ERRORS`)._
