# Testing Guide: Profile Management & Form Fill Flow

This guide helps you test the complete profile management and form-filling functionality after the bug fixes.

---

## Issues Fixed

### 1. **HTML Form Submission Bug (test-site/index.html)**
- **Root Cause:** JavaScript was reading form values using incorrect element IDs
  - Code looked for: `$("full-name")`, `$("email")`, `$("phone")`, `$("password")`, `$("message")`
  - Actual IDs in HTML: `#f1`, `#f2`, `#f3`, `#f6`, `#f8`
- **Impact:** Even when agent filled all fields correctly, form submission failed with `null` errors
- **Fix:** Updated both `submit` event handler and `resetForm()` function to use correct IDs

### 2. **Missing Profile Guidance**
- **Root Cause:** When agent couldn't find saved profile data, it only said "I don't have it saved"
- **Impact:** Users didn't know they could save data in extension settings
- **Fix:** Enhanced messaging to guide users to either:
  - Type the value in chat (will be auto-saved for next time)
  - Save it permanently in extension settings → Personal Profiles

### 3. **Profile Not Loaded on First Form Fill**
- **Root Cause:** Agent only loaded profile when user explicitly provided data in chat
- **Impact:** Even if user had saved profile in extension, agent wouldn't use it
- **Fix:** Agent now checks for saved profile at the start of `runPrompt()` and loads it automatically

### 4. **Profile Not Selected After Chat Save**
- **Root Cause:** When user provided data in chat, it was saved but not marked as "selected"
- **Impact:** Next form fill wouldn't use the saved data
- **Fix:** Explicitly set the saved profile as selected after persisting

---

## Testing Steps

### Test 1: Form Submission (HTML Bug Fix)

**Goal:** Verify form submission works when fields are filled manually or by agent

1. Start test server:
   ```bash
   cd test-site
   python3 -m http.server 8000
   ```

2. Open browser: `http://localhost:8000/`

3. **Manual Fill Test:**
   - Fill all required fields manually:
     - Full Name: `Test User`
     - Email: `test@example.com`
     - Phone: `1234567890`
     - Password: `TestPass123`
     - Country: `India`
   - Click "Submit Form"
   - ✅ **Expected:** Success modal appears with all your values displayed correctly
   - ❌ **Bug would show:** `null` errors or missing field values

4. **Agent Fill Test:**
   - Reload the page
   - Open RedactVision agent (floating launcher)
   - Tell agent: "Fill the form with name John Doe, email john@test.com, phone 9876543210, password SecurePass456"
   - Let agent fill the fields
   - Agent submits the form
   - ✅ **Expected:** Success modal appears with all agent-filled values

---

### Test 2: Profile Management Flow

**Goal:** Verify complete profile save → load → use flow

#### 2A. Save Profile in Extension Settings

1. Click RedactVision extension icon (toolbar)
2. Scroll to "Personal Profiles" section
3. Fill profile form:
   - Full Name: `Rahul Sharma`
   - Email: `rahul.sharma@example.com`
   - Phone: `9876543210`
   - Address: `Mumbai, India`
4. Click "Add Profile"
5. ✅ **Expected:** Profile card appears below with "Selected" badge
6. Verify profile shows:
   - Name: Rahul Sharma
   - Fields: name, email, phone, address

#### 2B. Use Saved Profile for Form Fill

1. Navigate to test page: `http://localhost:8000/`
2. Open RedactVision agent
3. Say: **"Fill this form with my saved profile"** or **"Fill the form"**
4. ✅ **Expected:** Agent shows: `Using saved profile: Rahul Sharma (4 fields)`
5. ✅ **Expected:** Agent fills name, email, phone from profile
6. ✅ **Expected:** Agent asks for password (not in profile)
7. Type password in chat: `MyPassword123`
8. ✅ **Expected:** Agent fills password and submits form
9. ✅ **Expected:** Success modal shows all correct values

---

### Test 3: Missing Profile Data Guidance

**Goal:** Verify improved messaging when profile data is missing

#### 3A. No Saved Profile

1. Clear extension data:
   - Open extension popup
   - Delete all saved profiles
2. Navigate to test page
3. Open agent and say: **"Fill the form"**
4. ✅ **Expected:** Agent asks for name/email/phone and shows:
   ```
   I need your Full Name to fill this field.
   I don't have this saved in your profile yet. You can either:
   • Type the value in the chat below, and I'll fill it now (and save it for next time)
   • Or save it in the extension settings: click the extension icon → Personal Profiles → add your details
   ```

#### 3B. Partial Profile (Some Fields Missing)

1. Save profile with only name and email (no phone)
2. Navigate to test page
3. Say: **"Fill the form"**
4. ✅ **Expected:** Agent uses name and email from profile
5. ✅ **Expected:** Agent asks for phone and shows clear guidance
6. Type phone: `9998887777`
7. ✅ **Expected:** Phone is saved to profile for next time

---

### Test 4: Chat-Provided Data Auto-Save

**Goal:** Verify data provided in chat is automatically saved to profile

1. Start with empty profile
2. Navigate to test page
3. Say: **"Fill the form with my name Priya Kumar, email priya@example.com, phone 8887776665"**
4. ✅ **Expected:** Agent shows: `Saved local profile detail(s): name, email, phone`
5. Agent fills those fields
6. Agent asks for password
7. Type: `PriyaPass789`
8. ✅ **Expected:** Form submits successfully
9. **Verify persistence:**
   - Open extension popup → Personal Profiles
   - ✅ **Expected:** Profile "Priya Kumar" exists with all 4 fields (including password from chat)
   - ✅ **Expected:** This profile is marked as "Selected"
10. **Test reuse:**
    - Reload page
    - Say: **"Fill the form again"**
    - ✅ **Expected:** Agent uses saved profile without asking

---

### Test 5: Multiple Profiles

**Goal:** Verify switching between profiles works

1. Save two profiles in extension:
   - Profile A: Rahul (email: rahul@test.com)
   - Profile B: Priya (email: priya@test.com)
2. Select Profile A (radio button)
3. Navigate to test page
4. Say: **"Fill the form"**
5. ✅ **Expected:** Agent uses Profile A data
6. Reload page
7. Open extension → select Profile B
8. Navigate to test page
9. Say: **"Fill the form"**
10. ✅ **Expected:** Agent uses Profile B data

---

### Test 6: Profile with Custom Fields

**Goal:** Verify custom fields work in profiles

1. Open extension popup
2. Create profile with custom field:
   - Full Name: `Test User`
   - Email: `test@example.com`
   - Phone: `1234567890`
   - Custom field name: `PAN Card`
   - Custom field value: `ABCDE1234F`
3. Click "Add Profile"
4. ✅ **Expected:** Profile shows custom field in pill: `PAN Card: ABCDE1234F`

---

### Test 7: End-to-End Integration Test

**Complete realistic user flow:**

1. **Fresh Start:**
   - Clear all extension data
   - Navigate to `http://localhost:8000/`

2. **First Form Fill (provides data in chat):**
   - Open agent
   - Say: **"Fill this form: my name is Amit Singh, email amit.singh@gmail.com, phone 9123456789, password Amit@2024"**
   - ✅ Agent extracts and saves profile
   - ✅ Agent fills all fields
   - ✅ Agent submits form
   - ✅ Success modal shows correct data

3. **Verify Profile Saved:**
   - Open extension popup
   - ✅ Profile "Amit Singh" exists with 4 fields
   - ✅ Profile is marked as "Selected"

4. **Second Form Fill (uses saved profile):**
   - Reload page
   - Open agent
   - Say: **"Fill the form"**
   - ✅ Agent says: `Using saved profile: Amit Singh (4 fields)`
   - ✅ Agent fills all fields without asking
   - ✅ Agent submits form
   - ✅ Success

5. **Third Form Fill (new field added to test page in future):**
   - (Hypothetically if form had a "City" field)
   - Agent would ask: "I need your City"
   - User types: `Delhi`
   - ✅ Agent saves city to profile
   - ✅ Next time, city is auto-filled

---

## Edge Cases to Test

### Edge 1: Invalid Form Data
- Try filling email with invalid format: `notanemail`
- ✅ **Expected:** Client-side validation catches it before LLM call

### Edge 2: Empty Profile Value
- Create profile with name but leave email empty
- Say "Fill the form"
- ✅ Agent should ask for email (treats empty as missing)

### Edge 3: Profile Deletion
- Create and select a profile
- Delete the profile
- ✅ Extension should auto-select another profile or none
- ✅ Agent should ask for data (not crash)

### Edge 4: Server Offline
- Stop the server (Ctrl+C in terminal)
- Try to fill form
- ✅ Agent should show "Server agent offline" message
- ✅ No crash or infinite loops

---

## Files Changed

1. **test-site/index.html**
   - Fixed `submit` event handler element IDs (lines 773-780)
   - Fixed `resetForm()` function element IDs (lines 759-764)

2. **extension/src/agent/agent-session.ts**
   - Enhanced missing profile messaging (lines 645-653)
   - Added profile selection after chat save (line 291)
   - Added auto-load of saved profile at `runPrompt()` start (lines 378-390)

---

## Success Criteria

All tests should pass without errors. Specifically:

- ✅ Form submission works with correct values (no `null` errors)
- ✅ Profiles saved in extension are loaded and used automatically
- ✅ Data provided in chat is auto-saved to profile
- ✅ Missing data shows helpful guidance pointing to extension settings
- ✅ Multiple profiles can be saved and switched between
- ✅ Agent clearly indicates which profile is being used

---

## Debugging Tips

If issues occur:

1. **Check Browser Console:**
   - Right-click page → Inspect → Console tab
   - Look for errors like `Cannot read property 'value' of null`

2. **Check Extension Console:**
   - Chrome → Extensions → RedactVision → "Inspect views: service worker"
   - Look for profile loading/saving errors

3. **Check Profile Storage:**
   - Open extension popup
   - Verify profiles are actually listed in Personal Profiles section
   - Verify "Selected" badge appears on active profile

4. **Verify Extension Build:**
   ```bash
   cd extension
   npm run build
   ```
   - Reload extension in Chrome
   - Refresh test page

5. **Check Server Logs:**
   ```bash
   cd server
   start-server
   ```
   - Look for incoming requests
   - Verify no 502/503 errors

---

## Next Steps After Testing

If all tests pass:
1. ✅ Mark this issue as resolved
2. Consider adding automated tests for form submission
3. Consider adding profile migration tests for future schema changes
4. Document profile management in user guide

If tests fail:
1. Note which specific test failed
2. Check browser/extension console for errors
3. Report the exact error message and steps to reproduce
