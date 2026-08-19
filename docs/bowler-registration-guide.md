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

**If a match is found:**
- The bowler's new user account is automatically linked to the existing bowler profile.
- The bowler is redirected to their dashboard — no further steps needed.

**If no match is found:**
- The bowler is redirected to the "Claim Bowler" page (see Step 3).

### Step 3: Claim Bowler Page (if needed)

If the system could not auto-link by email, the bowler sees a searchable list of unclaimed bowler profiles from your organization. They can:

- **Find their name** in the list and select it to link their account.
- **Skip** if they are not yet on any roster (they can be added later by an admin).

This page only shows bowlers who:
- Do not already have a linked user account
- Do not have an email address on file (bowlers with emails are expected to match automatically)

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

The invite email contains a link for the bowler to set up their password. The
new account is linked to the roster profile as part of issuing the invitation;
setting the password activates the account.

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
| Bowler registers with an email that matches their bowler profile | Automatically linked — goes straight to dashboard |
| Bowler registers with a different email than what's on file | Not auto-linked — goes to Claim Bowler page to find their name |
| Bowler registers but has no bowler profile yet | Goes to Claim Bowler page — can skip if not on a roster |
| Admin sends bulk invites to a league | Bowlers with emails and no existing account get an invitation and are linked to their roster profile atomically |
| Bowler with no email on file scans the QR code | Registers, then manually selects their name on the Claim Bowler page |
| Admin adds an email to a bowler profile that matches an existing user | Automatically linked at that point |

---

## Recommended Onboarding Strategy

For the smoothest experience, we recommend combining both approaches:

1. **Before bowling night:** Enter as many bowler emails as possible, then use "Send Registration Invites" to email them all at once. Bowlers who complete registration before arriving are already set up.

2. **On bowling night:** Place QR codes on the tables for any bowlers who haven't registered yet. They can sign up on their phone in under a minute.

This two-step approach typically results in 80-90% of bowlers being linked automatically, with the remaining bowlers easily finding their name on the Claim Bowler page.

---

## Troubleshooting

**Bowler says they registered but aren't showing as linked:**
- Check if their email matches what's on their bowler profile (common issue: different email addresses)
- Check the Users page to see if their account exists
- If needed, update the bowler profile's email to match their account email — linking will happen automatically

**Bowler can't find their name on the Claim Bowler page:**
- Their profile may already be linked to another account
- Their profile may have an email address on file (only bowlers without emails appear on the Claim Bowler page)
- Verify the bowler exists on a roster in one of your organization's leagues

**Bulk invite didn't send to a specific bowler:**
- Check that the bowler has an email address on their profile
- Check that they don't already have an account (invites are only sent to bowlers without accounts)
