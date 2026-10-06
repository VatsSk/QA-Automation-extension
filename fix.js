const fs = require('fs');
const files = ['popup/flow.js', 'popup/component.js'];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace("infoBtn.innerHTML = '?&nbsp;Info';", "infoBtn.innerHTML = 'ⓘ&nbsp;Info';");
  content = content.replace("icon.textContent = '?';", "icon.textContent = 'ⓘ';");
  content = content.replace("editBtn.textContent = '??';", "editBtn.textContent = '✏️';");
  content = content.replace("dupBtn.textContent = '??';", "dupBtn.textContent = '📋';");
  content = content.replace("delBtn.textContent = '??';", "delBtn.textContent = '🗑';");
  content = content.replace("footer.textContent = '? Information only  Not executed';", "footer.textContent = 'ⓘ Information only · Not executed';");
  content = content.replace("iconEl.textContent = '?';", "iconEl.textContent = 'ⓘ';");
  fs.writeFileSync(file, content, 'utf8');
}
console.log('Fixed encodings in JS files');
