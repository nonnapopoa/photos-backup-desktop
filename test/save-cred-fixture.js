// Test helper: writes a fake credential through the real CredentialStore into
// the real app's userData directory.
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { CredentialStore } = require(path.join(__dirname, '..', 'src', 'main', 'credentialStore'));
app.setPath('userData', path.join(os.homedir(), 'Library', 'Application Support', 'Photos Backup'));
app.whenReady().then(() => {
  const store = new CredentialStore();
  store.save({
    androidId: '0123456789abcdef',
    email: 'persist-test@example.com',
    masterToken: 'fake',
    authData: 'androidId=0123456789abcdef&Email=persist-test%40example.com&Token=fake&service=x&lang=en&sdk_version=33&oauth2_foreground=1&device_country=us&google_play_services_version=240913000&client_sig=x&callerSig=x',
    connectedAt: new Date().toISOString(),
  });
  console.log('SAVED');
  setTimeout(() => app.exit(0), 300);
});
