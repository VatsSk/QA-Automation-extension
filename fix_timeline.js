const fs = require('fs');

function fixTimelineLine(file) {
  let text = fs.readFileSync(file, 'utf8');
  
  // Hide the old timeline line
  text = text.replace(
    /\.timeline-line\s*\{[\s\S]*?\}/,
    `.timeline-line {\n  display: none !important;\n}`
  );
  
  // Check if timeline-steps::before already exists
  if (!text.includes('.timeline-steps::before')) {
    // Add ::before pseudo element to timeline-steps
    text = text.replace(
      /\.timeline-steps\s*\{([\s\S]*?)\}/,
      `.timeline-steps {\n$1}\n\n.timeline-steps::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 16px;\n  width: 2px;\n  background-color: var(--border-color);\n  z-index: -1;\n}`
    );
  }
  
  fs.writeFileSync(file, text, 'utf8');
}

fixTimelineLine('popup/flow.css');
fixTimelineLine('popup/component.css');

console.log('Fixed timeline line');
