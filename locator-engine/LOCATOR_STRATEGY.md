# Stable Locator Generation Strategy

## Overview
The locator generator now produces **stable, automation-friendly selectors** that avoid:
- ❌ Dynamic IDs (Mongo ObjectIds, UUIDs, generated numbers)
- ❌ Position-based selectors (nth-child, nth-of-type)
- ❌ Framework-generated classes (Mui*, css-*, ng-*, etc.)
- ❌ Long DOM chains that break on structural changes

## Dynamic ID Patterns (Automatically Ignored)

The following ID patterns are treated as unstable and ignored:

```javascript
/^[a-fA-F0-9]{24}$/           // Mongo ObjectId: 6a4e00cadc41e67881c1ed1a
/^[0-9a-fA-F-]{32,}$/         // UUID: 2f84b7a9-1eca-b432-...
/^[a-fA-F0-9]{16,}$/          // Long hex: 8b72c8a4d93f4a72
/^[0-9]{6,}$/                 // Numeric: 1698273412345
/^[A-Za-z0-9_-]{16,}$/        // Random tokens
```

Framework prefixes like `select2-`, `css-`, `jss`, `react-`, `MuiPaper`, etc. are also ignored.

## Unstable Class Patterns (Automatically Filtered)

These class patterns are filtered out:

```javascript
// State classes
active, selected, focus, hover, disabled, open, visible, show, hide

// Framework classes
ng-*, css-*, Mui*, chakra-*, ant-*, mat-*, v-*, react-*, ember*, jss*

// Hash-like classes
_a3f7k, _1x2y3z

// Numeric classes
123, 456
```

## Attribute Priority (Best to Worst)

### 1. **Test Attributes** (Score: 98-100)
- `data-testid` → `[data-testid="value"]`
- `data-test` → `[data-test="value"]`
- `data-cy` → `[data-cy="value"]`
- `data-qa` → `[data-qa="value"]`

### 2. **Stable ID** (Score: 95)
- Non-dynamic IDs only → `#login-button`

### 3. **Form Attributes** (Score: 88-90)
- `name` → `input[name="email"]`
- `name` (XPath) → `//input[@name="email"]`

### 4. **ARIA Attributes** (Score: 80-85)
- `aria-label` → `[aria-label="Submit form"]`
- `role` → `[role="button"]`

### 5. **Semantic Classes** (Score: 75)
- Non-framework classes → `a.task-description.primary`

### 6. **Custom Data Attributes** (Score: 70)
- `data-target` → `[data-target="#modal"]`
- Other stable `data-*` attributes

### 7. **Other Stable Attributes** (Score: 65-70)
- `href` → `a[href="/dashboard"]`
- `title` → `[title="Help"]`
- `placeholder` → `input[placeholder="Enter email"]`

### 8. **Contextual Locators** (Score: 78-85)
- Semantic class + attribute → `a.task-description[data-target="#edit"]`
- Parent ID + child → `#tasks-list > a.task-description`

### 9. **Text-Based** (Score: 55-60)
- Exact text → `//button[normalize-space(.)="Submit"]`
- Contains text → `//button[contains(normalize-space(.), "Submit")]`

### 10. **Smart Fallbacks** (Score: 45-50)
- CSS without positions → `a.task-description`
- XPath without positions → `//a[contains(@class, "task-description")]`

## Uniqueness Verification

Each locator is checked for uniqueness:
- ✅ Unique locators keep their high score
- ⚠️ Non-unique locators are downgraded (max score: 45) and marked with "(⚠ not unique)"

## Algorithm Flow

```
1. Check element for stable attributes (data-testid, name, aria-label, etc.)
   ↓ If unique stable locator found → STOP
   
2. Try contextual locators (semantic class + stable attribute)
   ↓ If still no unique locator → Continue
   
3. Generate text-based locators (for interactive elements only)
   ↓ If still no unique locator → Continue
   
4. Smart fallback (CSS/XPath without positions)
```

## Example Transformations

### Before (Unstable)
```css
#\36 a4e00cadc41e67881c1ed1a > td:nth-of-type(2) > div > a.task-description
```

### After (Stable)
```css
Primary: a.task-description[data-target="#edit-task-modal"]
Alternative: a.task-description
XPath: //a[@data-target='#edit-task-modal']
```

## Key Benefits

✅ **Resilient to changes**: Selectors survive DOM restructuring, ID regeneration, row reordering  
✅ **Database-agnostic**: Works across environments with different ObjectIds/UUIDs  
✅ **Readable**: Semantic selectors are self-documenting  
✅ **Maintainable**: No brittle position-based logic  
✅ **Accessible**: Prioritizes ARIA attributes and semantic HTML

## Testing Recommendations

When adding test automation attributes to your application:

1. **Best**: Add `data-testid` to all interactive elements
   ```html
   <button data-testid="submit-form">Submit</button>
   ```

2. **Good**: Use semantic classes
   ```html
   <button class="submit-button primary">Submit</button>
   ```

3. **Acceptable**: Ensure stable `name` and `aria-label` attributes
   ```html
   <input name="email" aria-label="Email address" />
   ```

4. **Avoid**: Relying on dynamic IDs or DOM structure
   ```html
   <!-- ❌ Bad -->
   <tr id="6a4e00cadc41e67881c1ed1a">
     <td>
       <a>Edit</a>
     </td>
   </tr>
   ```
