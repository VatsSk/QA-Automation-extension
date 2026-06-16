// ─── schema.js ───────────────────────────────────────────────────────────────
// Single source of truth for all scenario type definitions.
// captureMode: 'LOCATOR' | 'VALUE' | 'TEXT' | 'SYSTEM' | 'BOTH'

const TYPES = {
  URL: {
    label: 'URL Navigation',
    fields: ['url']
  },

  MODAL: {
    label: 'Modal Open',
    fields: []
  },

  URL_NAV: {
    label: 'URL + Navigation',
    fields: ['url']
  },

  MODAL_NAV: {
    label: 'Modal + Navigation',
    fields: ['cssSelector']
  },

  SEARCH_NAV: {
    label: 'Search Navigation',
    fields: [
      'cssSelector',
      'value'
    ]
  },

  VERIFY_PAGE: {
    label: 'Verify Page',
    fields: [
      'url',
      'cssSelector'
    ]
  },

  FORM_MODAL: {
    label: 'Form Modal',
    fields: [
      'cssSelector',
      'value',
      'clickCss'
    ]
  },

  ASSERT: {
    label: 'Assert',
    fields: [
      'assertType',
      'tableId',
      'locator',
      'expected',
      'columnName',
      'rangeId',
      'rowsBtn'
    ]
  },

  FILTER_NAV: {
    label: 'Filter Navigation',
    fields: [
      'filters',
      'applyBtnCss'
    ]
  },

  DATE_RANGE_NAV: {
    label: 'Date Range Navigation',
    fields: [
      'inputSelector',
      'selectionType',
      'preset',
      'startDate',
      'endDate',
      'applyButtonSelector',
      'calendarContainerSelector',
      'dateFormat'
    ]
  },

  MANAGE_COL_NAV: {
    label: 'Manage Columns',
    fields: [
      'columns',
      'saveBtnCss'
    ]
  },

  ROW_COUNT_NAV: {
    label: 'Row Count Check',
    fields: [
      'cssSelector',
      'value'
    ]
  }
};
const FIELD_META = {
  url: {
    label: 'URL',
    captureMode: 'TEXT',
    placeholder: 'https://...'
  },

  cssSelector: {
    label: 'CSS Selector',
    captureMode: 'LOCATOR',
    placeholder: '#element or .class'
  },

  value: {
    label: 'Value',
    captureMode: 'VALUE',
    placeholder: 'Input value or text'
  },

  clickCss: {
    label: 'Click CSS',
    captureMode: 'LOCATOR',
    placeholder: 'CSS selector to click after fill'
  },

  saveBtnCss: {
    label: 'Save Button CSS',
    captureMode: 'LOCATOR',
    placeholder: 'CSS selector of save button'
  },

  applyBtnCss: {
    label: 'Apply Filter Button CSS',
    captureMode: 'LOCATOR',
    placeholder: 'CSS selector of apply button'
  },

  applyButtonSelector: {
    label: 'Apply Button Selector',
    captureMode: 'LOCATOR',
    placeholder: 'CSS selector of apply button'
  },

  inputSelector: {
    label: 'Input Selector',
    captureMode: 'LOCATOR',
    placeholder: 'CSS selector of date input'
  },

  calendarContainerSelector: {
    label: 'Calendar Container',
    captureMode: 'LOCATOR',
    placeholder: 'CSS selector of calendar'
  },

  dateFormat: {
    label: 'Date Format',
    captureMode: 'TEXT',
    placeholder: 'YYYY-MM-DD'
  },

  tableId: {
    label: 'Table ID',
    captureMode: 'VALUE',
    placeholder: 'Table element ID'
  },

  locator: {
    label: 'Locator',
    captureMode: 'LOCATOR',
    placeholder: 'CSS or XPath selector'
  },

  expected: {
    label: 'Expected Value',
    captureMode: 'VALUE',
    placeholder: 'Expected text or value'
  },

  columnName: {
    label: 'Column Name',
    captureMode: 'VALUE',
    placeholder: 'Column header name'
  },

  rangeId: {
    label: 'Range ID',
    captureMode: 'VALUE',
    placeholder: 'Date range element ID'
  },

  rowsBtn: {
    label: 'Rows Button CSS',
    captureMode: 'LOCATOR',
    placeholder: 'CSS of rows-per-page button'
  },

  promptAi: {
    label: 'AI Prompt',
    captureMode: 'TEXT',
    placeholder: 'Describe what to assert...'
  },

  order: {
    label: 'Sort Order',
    captureMode: 'SYSTEM'
  },

  selectionType: {
    label: 'Selection Type',
    captureMode: 'SYSTEM'
  },

  preset: {
    label: 'Preset',
    captureMode: 'SYSTEM'
  },

  startDate: {
    label: 'Start Date',
    captureMode: 'VALUE',
    placeholder: 'YYYY-MM-DD'
  },

  endDate: {
    label: 'End Date',
    captureMode: 'VALUE',
    placeholder: 'YYYY-MM-DD'
  },

  assertType: {
    label: 'Assert Type',
    captureMode: 'SYSTEM'
  }
};
const ASSERT_TYPES = {
  ASSERT_VISIBLE: {
    label: 'Element Visible',
    fields: ['locator']
  },

  ASSERT_NOT_VISIBLE: {
    label: 'Element Not Visible',
    fields: ['locator']
  },

  ASSERT_TEXT_EQUALS: {
    label: 'Assert Column Value(s)',
    fields: ['tableId', 'columnName', 'expected']
  },

  ASSERT_TEXT_CONTAINS: {
    label: 'Text Contains',
    fields: ['locator', 'expected']
  },

  ASSERT_COLUMN_PRESENT: {
    label: 'Column(s) Present',
    fields: ['tableId', 'columnName']
  },

  ASSERT_COUNT: {
    label: 'Pagination',
    fields: ['tableId', 'rowsBtn']
  },

  ASSERT_SORT_ORDER: {
    label: 'Sort Order',
    fields: ['tableId', 'columnName', 'order']
  },

  ASSERT_ATTRIBUTE: {
    label: 'Attribute',
    fields: ['locator', 'expected']
  },

  ASSERT_AI: {
    label: 'Assert With AI',
    fields: ['promptAi']
  },

  ASSERT_FILTER: {
    label: 'Assert Table Filter',
    fields: ['tableId']
  },

  ASSERT_MANAGE_COLUMN: {
    label: 'Assert Manage Column',
    fields: ['tableId']
  },

  ASSERT_ROWS_COUNT: {
    label: 'Assert Table Rows',
    fields: ['tableId']
  }
};

const FILTER_TYPES = [
  { value: 'TEXT', label: 'Text' },
  { value: 'DATE', label: 'Date' },
  { value: 'DATE_TIME', label: 'Date Time' },
  { value: 'NUMBER', label: 'Number' }
];

const FILTER_OPERATIONS = {
  TEXT: [
    { value: 'EQUALS', label: 'Equals' },
    { value: 'NOT_EQUALS', label: 'Not Equals' },
    { value: 'CONTAINS', label: 'Contains' },
    { value: 'STARTS_WITH', label: 'Starts With' }
  ],

  DATE: [
    { value: 'EQUALS', label: 'Equals' },
    { value: 'GREATER_THAN', label: 'Greater Than' },
    { value: 'LESS_THAN', label: 'Less Than' },
    { value: 'RANGE', label: 'Date Range' }
  ],

  DATE_TIME: [
    { value: 'EQUALS', label: 'Equals' },
    { value: 'GREATER_THAN', label: 'Greater Than' },
    { value: 'LESS_THAN', label: 'Less Than' },
    { value: 'RANGE', label: 'Date Range' }
  ],

  NUMBER: [
    { value: 'EQUALS', label: 'Equals' },
    { value: 'GREATER_THAN', label: 'Greater Than' },
    { value: 'LESS_THAN', label: 'Less Than' }
  ]
};

const SORT_ORDER_OPTIONS = [
  { value: 'ascending', label: 'Ascending' },
  { value: 'descending', label: 'Descending' }
];

const DATE_PRESET_TYPES = [
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: 'THIS_MONTH', label: 'This Month' },
  { value: 'LAST_MONTH', label: 'Last Month' }
];

const MANAGE_COLUMN_ACTIONS = [
  { value: '', label: 'Default' },
  { value: 'SHOW', label: 'Show' },
  { value: 'HIDE', label: 'Hide' }
];
const REQUIRED = {
  URL: ['url'],
  MODAL: [],
  URL_NAV: ['url'],
  MODAL_NAV: ['cssSelector'],
  SEARCH_NAV: ['cssSelector', 'value'],
  VERIFY_PAGE: ['url', 'cssSelector'],
  FORM_MODAL: [],
  ASSERT: [],
  FILTER_NAV: ['applyBtnCss'],
  DATE_RANGE_NAV: [
    'inputSelector',
    'selectionType',
    'applyButtonSelector',
    'calendarContainerSelector'
  ],
  MANAGE_COL_NAV: ['saveBtnCss'],
  ROW_COUNT_NAV: []
};