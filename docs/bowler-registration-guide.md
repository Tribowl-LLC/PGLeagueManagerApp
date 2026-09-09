# Bowler Registration Guide

An internal reference for organization administrators on how the bowler sign-up and account linking system works in LeagueVault.

---

## Overview

LeagueVault provides a self-service registration system for bowlers. When a bowler creates an account, the system automatically links them to their existing bowler profile if possible, ensuring a seamless onboarding experience.

Each organization has a unique sign-up URL that can be shared via QR code, email, or printed materials.

---

## Your Organization Sign-Up URL

Your bowlers register at a URL specific to your organization:

```
https://leaguevault.app/signup?org=[your-slug]
```

For example, if your organization slug is `perfect-game`, the URL would be:

```
https://leaguevault.app/signup?org=perfect-game
```

When bowlers visit this URL, they will see:
- Your organization's logo at the top of the page
- A welcome message with your organization name
- A league dropdown showing only your organization's leagues

You can find your organization slug in the admin settings, or ask your system administrator.

---

## Registration Flow

### Step 1: Bowler Fills Out the Sign-Up Form

The bowler provides:
- **Full Name** (required)
- **Email Address** (required)
- **Phone Number** (required)
- **League** (required — selected from a dropdown of your organization's active leagues)
- **Password** (required — must meet complexity requirements)

### Step 2: Automatic Account Linking

After the bowler submits the form, the system checks whether a bowler profile already exists with a matching email address within your organization's leagues.

**If exactly one match is found:**
- The bowler's new user account is automatically linked to the existing bowler profile.
- The bowler is redirected to their dashboard — no further steps needed.

**If no unique match is found:**
- The account is created but remains pending until an organization administrator
  links it to a roster profile or creates a new profile.
- A duplicate/shared email is intentionally left pending for administrator
  review; a name match alone never proves ownership.

### Step 3: Pending account review (if needed)

If the system could not find exactly one email match, the account stays pending;
the user cannot claim a profile by name. An organization administrator can
review pending users and either create a bowler profile for the user or link
the account to an existing unlinked profile. Administrators may resolve
duplicate/shared-email cases manually, subject to the same organization
boundaries as every other admin action.

After a successful link, LeagueVault attempts one account-ready message. The
message confirms account access and links to the organization's sign-in page;
account readiness is separate from whether any league balance is currently
payable. Delivery is reported as accepted (submitted to the provider) or
not_sent; accepted does not guarantee inbox delivery.

---

## How to Prepare for Registration Night

To get the best results with automatic linking, follow these steps before your first bowling night:

### 1. Enter Bowler Email Addresses

The most important preparation step. For each bowler on your rosters, make sure their email address is entered in their bowler profile. When the email on the bowler profile matches the email they use to register, linking happens automatically with no extra steps.

**To add emails:**
- Go to the team roster page
- Click "Edit" next to each bowler
- Enter their email address and save

### 2. Create a QR Code

Generate a QR code that points to your sign-up URL. You can use any free QR code generator. Place printed copies on each lane or table on bowling night.

### 3. Send Bulk Registration Invites (Optional)

Instead of (or in addition to) QR codes, you can send email invites to all bowlers at once:

1. Go to the league detail page
2. Click "Send Registration Invites"
3. The system will send an invite email to every bowler who has an email address but does not yet have an account

The invite email contains a link for the bowler to set up their password. This
is an invitation flow and does not send account-ready messages to existing
linked users in bulk.

After sending, you will see a summary:
- How many invites were sent
- How many bowlers already had accounts
- How many bowlers had no email on file (these bowlers need their email added first, or they can self-register via QR code)

---

## Account Status Indicators

On the team roster page, each bowler's name has a check mark icon next to it:

- **Green check mark** — The bowler has a linked user account
- **Grey check mark** — The bowler does not yet have an account

On the Users management page, a "Linked Bowler" column shows which user accounts are connected to bowler profiles and which are not.

---

## Scenarios and What Happens

| Scenario | What Happens |
|----------|-------------|
| Bowler registers with exactly one matching profile email | Automatically linked — can sign in and view leagues |
| Bowler registers with a different email than what's on file | Account remains pending for administrator review |
| Multiple profiles share the registration email | Account remains pending; an administrator resolves the ambiguity |
| Bowler registers but has no bowler profile yet | Administrator can create and assign a profile later |
| Admin sends bulk invites to a league | Bowlers with emails and no existing account get an invitation and are linked to their roster profile atomically |
| Bowler with no email on file scans the QR code | Registers, then remains pending until an administrator adds/links a profile |
| Admin adds an email to a bowler profile that matches an existing user | Automatically linked at that point |

---

## Recommended Onboarding Strategy

For the smoothest experience, we recommend combining both approaches:

1. **Before bowling night:** Enter as many bowler emails as possible, then use "Send Registration Invites" to email them all at once. Bowlers who complete registration before arriving are already set up.

2. **On bowling night:** Place QR codes on the tables for any bowlers who haven't registered yet. They can sign up on their phone in under a minute. Make sure the email they use matches the roster email exactly.

Review any pending accounts from the administrator page. There is no durable
email queue or automatic retry guarantee; if an account-ready message is not
sent, an administrator can manually use **Resend account-ready email** for an
already-linked ordinary user.

---

## Troubleshooting

**Bowler says they registered but aren't showing as linked:**
- Check if their email matches what's on their bowler profile (common issue: different email addresses)
- Check the pending users list and the Users page to see if their account exists
- If needed, have an administrator link the account to the correct unlinked profile or create a new profile

**Bowler is pending after registration:**
- A unique matching email was not found, or multiple profiles share that email
- An administrator must resolve the pending account; name-only self-claims are not available
- After linking, use the manual account-ready resend action if the original message was not sent

**Bulk invite didn't send to a specific bowler:**
- Check that the bowler has an email address on their profile
- Check that they don't already have an account (invites are only sent to bowlers without accounts)
