const fs = require('fs');

function fixFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace("infoBtn.innerHTML = '?&nbsp;Info';", "infoBtn.innerHTML = 'ⓘ&nbsp;Info';");
  text = text.replace("icon.textContent = '?';", "icon.textContent = 'ⓘ';");
  text = text.replace("iconEl.textContent = '?';", "iconEl.textContent = 'ⓘ';");
  text = text.replace("editBtn.textContent = '??';", "editBtn.textContent = '✏️';");
  text = text.replace("dupBtn.textContent = '??';", "dupBtn.textContent = '📋';");
  text = text.replace("delBtn.textContent = '??';", "delBtn.textContent = '🗑';");
  text = text.replace("footer.textContent = '? Information only  Not executed';", "footer.textContent = 'ⓘ Information only · Not executed';");
  fs.writeFileSync(file, text, 'utf8');
}

fixFile('popup/flow.js');
fixFile('popup/component.js');
console.log('Done');
