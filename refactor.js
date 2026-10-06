const fs = require('fs');

function refactorJs(file) {
  let text = fs.readFileSync(file, 'utf8');
  
  // Fix scrolling bug
  text = text.replace(/els\.timelineSteps\.querySelectorAll\('\.step-card'\)/g, 'els.timelineSteps.children');
  
  // Remove footer from JS
  const footerRegex = /\/\/ Footer badge[\s\S]*?wrapper\.appendChild\(card\);/;
  const newFooterLogic = `
  card.appendChild(header);
  card.appendChild(desc);
  wrapper.appendChild(card);
`;
  text = text.replace(footerRegex, newFooterLogic);
  
  fs.writeFileSync(file, text, 'utf8');
}

function refactorCss(file) {
  let text = fs.readFileSync(file, 'utf8');
  
  // Refactor .info-step-wrapper
  text = text.replace(
    /\.info-step-wrapper\s*\{[\s\S]*?\}/,
    `.info-step-wrapper {
  animation: slideIn 0.3s ease-out forwards;
  margin-left: 0;
  position: relative;
  z-index: 10;
  margin: 16px 0;
}`
  );
  
  // Refactor .info-step-card
  text = text.replace(
    /\.info-step-card\s*\{[\s\S]*?\}/,
    `.info-step-card {
  background: var(--bg-dark);
  border: 1px dashed var(--step-info);
  border-left: 4px solid var(--step-info);
  border-radius: var(--radius);
  padding: 12px 16px;
  position: relative;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  transition: all 0.2s ease;
}`
  );
  
  // Refactor .info-step-label
  text = text.replace(
    /\.info-step-label\s*\{[\s\S]*?\}/,
    `.info-step-label {
  display: none;
}`
  );
  
  // Refactor .info-step-description
  text = text.replace(
    /\.info-step-description\s*\{[\s\S]*?\}/,
    `.info-step-description {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--step-info);
  white-space: pre-wrap;
  word-break: break-word;
}`
  );
  
  // Remove footer css completely
  text = text.replace(/\.info-step-footer\s*\{[\s\S]*?\}/g, '');
  
  fs.writeFileSync(file, text, 'utf8');
}

['popup/flow.js', 'popup/component.js'].forEach(refactorJs);
['popup/flow.css', 'popup/component.css'].forEach(refactorCss);

console.log('Refactored successfully');
