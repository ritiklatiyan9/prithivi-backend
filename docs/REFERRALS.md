# Referral rewards

## Admin controls

The updated admin panel exposes these controls on **Referrals**. Super admins can edit them; admins can inspect them.

| Setting | Meaning | Default when no override exists |
| --- | --- | --- |
| `referral.enabled` | Accept new referral-code applications | `true` |
| `referral.rewardPoints` | Coins given to the inviter/code owner | `50` (preserves existing overrides) |
| `referral.inviteeRewardPoints` | Coins given to the joining friend | `0` |

Both amounts accept whole coins from 0 to 1,000,000. The joining reward starts at zero to avoid introducing an unapproved reward cost. An administrator should set the intended amount. Saving settings affects new claims immediately across API workers. Existing ledger entries are never recalculated.

## Client contract

`GET /users/me/referrals` returns `referralCode`, `referredCount`, `coinsEarned`, `hasApplied`, and `policy: { enabled, rewardPoints, inviteeRewardPoints }`.

`POST /users/me/referral` accepts `{ code }` and returns `{ applied: true, alreadyApplied, rewardPoints, inviteeRewardPoints }`. The amounts in that response are the claim's actual receipt, not a copy of a previously fetched offer.

Codes are trimmed, normalized to uppercase and validated as 1–16 alphanumeric characters. The endpoint is authenticated and rate-limited. Invalid, self, inactive-account, reciprocal and already-used/different-code claims are rejected.

## Settlement and retries

Both accounts are locked in deterministic ID order. A single transaction reads current referral settings, marks the joining account, credits both wallets and records both ledger entries. A failure rolls back the entire transaction. Concurrent requests cannot independently mark the same account.

Ledger references are `referral:<joiningUserId>` for the inviter and `referral-join:<joiningUserId>` for the joining friend. Zero-value entries preserve original terms. Retrying the same code returns that receipt without crediting again, even if settings subsequently change or the programme pauses. Notifications occur after commit and are best-effort.

Deleting an inviter clears `referredById` on remaining accounts but preserves `referredAt`, so those accounts remain ineligible for another claim. This does not reconstruct claim markers erased by deletions before this update. Rolling back to older referral code would also lose this guard; preserve the `referredAt` eligibility check in any rollback.

Referral-code backfills use a conditional update so concurrent sign-ins/stats requests never replace a code that was already shared.

## Sharing

The app shares `https://play.google.com/store/apps/details?id=com.rewardhub.rewardhub_app` plus the invite code and instructions. The recipient applies the code during onboarding or on Share & Earn. Merely sharing, opening a link or installing the app does not issue a reward. This version uses explicit code entry, not automatic install attribution.

## Deploy and verify

No database schema migration is required. Deploy the backend before the admin/app update. The backend's active Render branch must be confirmed (`dev` or `main`); local work was prepared from `dev` at `9f97194`. The admin repository uses `main`.

After deployment, check that the referral stats response contains `policy`, that the admin Referrals screen exposes both amounts, and that old claims retain their recorded amounts. Use designated test accounts for any real end-to-end credit test; do not claim referrals on customer accounts as a test.

Local validation: TypeScript build and 159 backend tests pass, including 25 referral cases. The transaction unit-test double simulates serialization and rollback; it is not a live PostgreSQL concurrency test. The Flutter suite has 45 passing tests including native-share invocation, server receipt handling, duplicate-tap protection, error states, and narrow/large-text layouts.
