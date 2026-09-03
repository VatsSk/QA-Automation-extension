// ─── schema.js ───────────────────────────────────────────────────────────────
// Loaded as a plain <script> (not a module) — no export/import keywords.

// ─────────────────────────────────────────────────────────────────────────────
// Scenario Defaults
// ─────────────────────────────────────────────────────────────────────────────
const SCENARIO_DEFAULTS = {
  initialVerifications: [], // runs BEFORE scenario
  finalVerifications: []    // runs AFTER scenario
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
const TYPES = {
  URL: {
    label: 'URL',
    icon: '🔗',
    color: 'var(--blue)',
    bg: 'var(--blue-d)',
    fields: ['url'],
    hasData: true,
    hint: 'Navigate to a URL and run test cases'
  },

  MODAL: {
    label: 'Modal Test',
    icon: '◫',
    color: 'var(--pu)',
    bg: 'var(--pu-d)',
    fields: [],
    hasData: true,
    hint: 'Open modal and run test cases'
  },

  URL_NAV: {
    label: 'URL + Navigation',
    icon: '→',
    color: 'var(--te)',
    bg: 'var(--te-d)',
    fields: ['url'],
    hasData: false,
    hint: 'Navigate to URL without test data'
  },

  MODAL_NAV: {
    label: 'Navigation Modal',
    icon: '⇌',
    color: 'var(--am)',
    bg: 'var(--am-d)',
    fields: ['cssSelector'],
    hasData: false,
    hint: 'Open modal using selector'
  },

  SEARCH_NAV: {
    label: 'Search Navigation',
    icon: '⌕',
    color: 'var(--gr)',
    bg: 'var(--gr-d)',
    fields: ['cssSelector', 'value'],
    hasData: false,
    hint: 'Search using input field'
  },

  VERIFY_PAGE: {
    label: 'Verify Page',
    icon: '✓',
    color: 'var(--gr)',
    bg: 'var(--gr-d)',
    fields: ['url'],
    hasData: false,
    hint: 'Verify page content'
  },

  FORM_MODAL: {
    label: 'Form Modal',
    icon: '📝',
    color: 'var(--purple)',
    bg: 'var(--purple-d)',
    fields: ['cssSelector', 'value', 'clickCss'],
    hasData: true,
    hint: 'Fill form field and optionally click'
  },

  ASSERT: {
    label: 'Assert',
    icon: '✓',
    color: 'var(--or)',
    bg: 'var(--or-d)',
    fields: ['assertions'],
    hasData: false,
    dynamicFields: true,
    hint: 'Assert UI or data conditions'
  },

  FILTER_NAV: {
    label: 'Filter Navigation',
    icon: '⛃',
    color: 'var(--cyan)',
    bg: 'var(--cyan-d)',
    fields: ['filters', 'applyBtnCss'],
    hasData: false,
    dynamicFields: true,
    hint: 'Apply filters and trigger search'
  },

  DATE_RANGE_NAV: {
    label: 'Date Range Navigation',
    icon: '📅',
    color: 'var(--pink)',
    bg: 'var(--pink-d)',
    fields: [
      'inputSelector',
      'selectionType',
      'preset',
      'startDate',
      'endDate',
      'applyButtonSelector',
      'calendarContainerSelector',
      'dateFormat'
    ],
    hasData: false,
    dynamicFields: true,
    hint: 'Select date range'
  },

  MANAGE_COL_NAV: {
    label: 'Manage Columns',
    icon: '📑',
    color: 'var(--indigo)',
    bg: 'var(--indigo-d)',
    fields: ['columns', 'saveBtnCss'],
    hasData: false,
    dynamicFields: true,
    hint: 'Show/hide columns'
  },

  ROW_COUNT_NAV: {
    label: 'Row Count Check',
    icon: '📊',
    color: 'var(--pri)',
    bg: 'var(--pri-bg)',
    fields: ['cssSelector', 'value'],
    hasData: false,
    hint: 'Change rows count'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FIELD META
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_META = {
  url:                       { label: 'URL',                      captureMode: 'URL',    placeholder: 'https://...' },
  cssSelector:               { label: 'CSS Selector',             captureMode: 'LOCATOR', placeholder: '#element or .class' },
  value:                     { label: 'Value',                    captureMode: 'VALUE',  placeholder: 'Input value or text' },
  clickCss:                  { label: 'Click CSS',                captureMode: 'LOCATOR', placeholder: 'CSS selector to click after fill' },
  saveBtnCss:                { label: 'Save Button CSS',          captureMode: 'LOCATOR', placeholder: 'CSS selector of save button' },
  applyBtnCss:               { label: 'Apply Filter Button CSS',  captureMode: 'LOCATOR', placeholder: 'CSS selector of apply button' },
  applyButtonSelector:       { label: 'Apply Button Selector',    captureMode: 'LOCATOR', placeholder: 'CSS selector of apply button' },
  inputSelector:             { label: 'Input Selector',           captureMode: 'LOCATOR', placeholder: 'CSS selector of date input' },
  calendarContainerSelector: { label: 'Calendar Container',       captureMode: 'LOCATOR', placeholder: 'CSS selector of calendar' },
  dateFormat:                { label: 'Date Format',              captureMode: 'TEXT',   placeholder: 'YYYY-MM-DD' },
  tableId:                   { label: 'Table CSS',            captureMode: 'LOCATOR', placeholder: 'CSS selector of the table' },
  locator:                   { label: 'CSS Selector',         captureMode: 'LOCATOR', placeholder: 'CSS or XPath selector' },
  expected:                  { label: 'Expected Value',       captureMode: 'VALUE',  placeholder: 'For text: substring / For column: comma-separated values' },
  columnName:                { label: 'Column Name(s)',       captureMode: 'VALUE',  placeholder: 'Column header name (comma-separated for multiple)' },
  rangeId:                   { label: 'Range ID',                 captureMode: 'VALUE',  placeholder: 'Date range element ID' },
  rowsBtn:                   { label: 'Rows Button CSS',          captureMode: 'LOCATOR', placeholder: 'CSS of rows-per-page button' },
  promptAi:                  { label: 'AI Prompt',                captureMode: 'TEXT',   placeholder: 'Describe what to assert...' },
  order:                     { label: 'Sort Order',               captureMode: 'SYSTEM' },
  selectionType:             { label: 'Selection Type',           captureMode: 'SYSTEM' },
  preset:                    { label: 'Preset',                   captureMode: 'SYSTEM' },
  startDate:                 { label: 'Start Date',               captureMode: 'VALUE',  placeholder: 'YYYY-MM-DD' },
  endDate:                   { label: 'End Date',                 captureMode: 'VALUE',  placeholder: 'YYYY-MM-DD' },
  assertType:                { label: 'Assert Type',              captureMode: 'SYSTEM' }
};

// ─────────────────────────────────────────────────────────────────────────────
// ASSERT TYPES
// ─────────────────────────────────────────────────────────────────────────────
const ASSERT_TYPES = {
  ASSERT_VISIBLE:        { label: 'Element Visible',       fields: ['locator'],                        required: ['locator'] },
  ASSERT_NOT_VISIBLE:    { label: 'Element Not Visible',   fields: ['locator'],                        required: ['locator'] },
  ASSERT_NOT_EXISTS:     { label: 'Element Not Exists',    fields: ['locator'],                        required: ['locator'] },
  ASSERT_TEXT_CONTAINS:  { label: 'Text Contains',         fields: ['locator', 'expected'],             required: ['locator', 'expected'] },
  ASSERT_TEXT_EQUALS:    { label: 'Assert Column Value(s)',fields: ['tableId', 'columnName', 'expected'],required: ['tableId', 'columnName', 'expected'] },
  ASSERT_COLUMN_PRESENT: { label: 'Column(s) Present',     fields: ['tableId', 'columnName'],           required: ['tableId', 'columnName'] },
  ASSERT_SORT_ORDER:     { label: 'Sort Order',            fields: ['tableId', 'columnName', 'order'],  required: ['tableId', 'columnName', 'order'] },
  ASSERT_COUNT:          { label: 'Pagination',            fields: ['tableId', 'rowsBtn'],              required: ['tableId', 'rowsBtn'] },
  ASSERT_ATTRIBUTE:      { label: 'Attribute',             fields: ['locator', 'expected'],             required: ['locator', 'expected'] },
  ASSERT_AI:             { label: 'Assert With AI',        fields: ['promptAi'],                        required: ['promptAi'] },
  ASSERT_FILTER:         { label: 'Assert Table Filter',   fields: ['tableId'],                         required: ['tableId'] },
  ASSERT_MANAGE_COLUMN:  { label: 'Assert Manage Column',  fields: ['tableId'],                         required: ['tableId'] },
  ASSERT_ROWS_COUNT:     { label: 'Assert Table Rows',     fields: ['tableId'],                         required: ['tableId'] },
};

// ─────────────────────────────────────────────────────────────────────────────
// FILTER / SORT / DATE
// ─────────────────────────────────────────────────────────────────────────────
const FILTER_TYPES = [
  { value: 'TEXT',      label: 'Text' },
  { value: 'DATE',      label: 'Date' },
  { value: 'DATE_TIME', label: 'Date Time' },
  { value: 'NUMBER',    label: 'Number' }
];

const FILTER_OPERATIONS = {
  TEXT: [
    { value: 'EQUALS',      label: 'Equals' },
    { value: 'NOT_EQUALS',  label: 'Not Equals' },
    { value: 'CONTAINS',    label: 'Contains' },
    { value: 'STARTS_WITH', label: 'Starts With' }
  ],
  DATE: [
    { value: 'EQUALS',       label: 'Equals' },
    { value: 'GREATER_THAN', label: 'Greater Than' },
    { value: 'LESS_THAN',    label: 'Less Than' },
    { value: 'RANGE',        label: 'Date Range' }
  ],
  DATE_TIME: [
    { value: 'EQUALS',       label: 'Equals' },
    { value: 'GREATER_THAN', label: 'Greater Than' },
    { value: 'LESS_THAN',    label: 'Less Than' },
    { value: 'RANGE',        label: 'Date Range' }
  ],
  NUMBER: [
    { value: 'EQUALS',       label: 'Equals' },
    { value: 'GREATER_THAN', label: 'Greater Than' },
    { value: 'LESS_THAN',    label: 'Less Than' }
  ]
};

const SORT_ORDER_OPTIONS = [
  { value: 'ascending',  label: 'Ascending' },
  { value: 'descending', label: 'Descending' }
];

const DATE_PRESET_TYPES = [
  { value: 'TODAY',      label: 'Today' },
  { value: 'YESTERDAY',  label: 'Yesterday' },
  { value: 'THIS_MONTH', label: 'This Month' },
  { value: 'LAST_MONTH', label: 'Last Month' }
];

const DATE_SELECTION_TYPES = [
  { value: 'PRESET', label: 'Preset' },
  { value: 'CUSTOM', label: 'Custom Range' }
];

const MANAGE_COLUMN_ACTIONS = [
  { value: '',     label: 'Default' },
  { value: 'SHOW', label: 'Show' },
  { value: 'HIDE', label: 'Hide' }
];

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED fields per scenario type
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED = {
  URL:            ['url'],
  MODAL:          [],
  URL_NAV:        ['url'],
  MODAL_NAV:      ['cssSelector'],
  SEARCH_NAV:     ['cssSelector', 'value'],
  VERIFY_PAGE:    ['url'],
  FORM_MODAL:     [],
  ASSERT:         [],
  FILTER_NAV:     ['applyBtnCss'],
  DATE_RANGE_NAV: [
    'inputSelector',
    'selectionType',
    'applyButtonSelector',
    'calendarContainerSelector'
  ],
  MANAGE_COL_NAV: ['saveBtnCss'],
  ROW_COUNT_NAV:  []
};