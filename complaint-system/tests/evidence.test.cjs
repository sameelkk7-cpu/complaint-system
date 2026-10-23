const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

// Exercise the actual submission handler with isolated storage and AI services.
async function submit(category, files = {}, aiFails = false) {
  const source = read('backend/routes/complaints.js');
  const route = source.slice(source.indexOf("router.post('/',"), source.indexOf('// Re-run AI audio verification'));
  let handler, completion, stored, calls = 0, status, body;
  const cleaned = [];
  vm.runInNewContext(route, {
    router: { post: (_url, _auth, fn) => { handler = fn; } }, optionalAuth() {},
    uploadFields: (_req, _res, fn) => { completion = fn(); },
    fs: { unlink: name => cleaned.push(name) },
    validateAudioFile: () => null,
    analyzeAudio: async () => { calls++; if (aiFails) throw Error('offline'); return { top_category: 'Loud Music', confidence: 0.9 }; },
    verdictFor: () => 'Verified', blockOf: () => null, logAction() {}, parseDetails: c => c,
    console: { warn() {} },
    db: { prepare: () => ({ run: (...values) => { stored = values; return { lastInsertRowid: 1 }; }, get: () => ({ id: 1 }) }) }
  });
  handler({ body: { category, description: 'Test complaint' }, files, user: { id: 1 } }, {
    status(code) { status = code; return this; }, json(value) { body = value; }
  });
  await completion;
  return { status, body, stored, calls, cleaned };
}
const audio = { path: 'test.wav', filename: 'test.wav' };
const photo = { path: 'test.jpg', filename: 'test.jpg' };
test('noise requires audio and rejects photos', async () => {
  assert.equal((await submit('Noise Disturbance')).status, 400);
  const result = await submit('Noise Disturbance', { audio: [audio], photo: [photo] });
  assert.equal(result.status, 400);
  assert.equal(result.cleaned.length, 2);
});
test('noise recording is analyzed; service failure goes to manual review', async () => {
  for (const fails of [false, true]) {
    const result = await submit('Noise Disturbance', { audio: [audio] }, fails);
    assert.equal(result.status, 201);
    assert.equal(result.calls, 1);
    assert.equal(result.stored[9], fails ? 'Unverified' : 'Pending');
  }
});
test('other categories accept optional photos without audio analysis', async () => {
  for (const category of ['Parking', 'Cleanliness', 'Nuisance', 'Other']) {
    for (const files of [{}, { photo: [photo] }]) {
      const result = await submit(category, files);
      assert.equal(result.status, 201);
      assert.equal(result.calls, 0);
      assert.equal(result.stored[5], null);
      assert.equal(result.stored[9], 'Pending');
      assert.equal(result.stored[13], 'Not Applicable');
    }
    assert.equal((await submit(category, { audio: [audio] })).status, 400);
  }
  assert.equal((await submit('invalid')).status, 400);
});

for (const [file, prefix] of [['index.html', 'pub'], ['user-dashboard.html', '']]) {
  test(`${file}: evidence and submission state follow category`, () => {
    const html = read('frontend/' + file);
    const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    new vm.Script(source);
    const nodes = {};
    const get = id => nodes[id] ||= { style: {}, value: 'Noise Disturbance' };
    const category = prefix ? 'pubCategorySel' : 'categorySel';
    const update = prefix ? 'updatePubSubmitState' : 'updateSubmitState';
    const validate = prefix ? 'validatePubAudio' : 'validateAudio';
    const fragment = source.slice(source.indexOf('  const ' + category + ' ='), source.indexOf('  function ' + validate));
    const ctx = vm.createContext({ document: { getElementById: get }, setupPhotoEvidence: () => ({ close() {} }) });
    vm.runInContext(fragment, ctx);
    const submitButton = get(prefix ? 'pubSubmitBtn' : 'submitBtn');
    assert.equal(submitButton.disabled, true);
    assert.equal(get('photoEvidence').hidden, true);
    vm.runInContext(`${category}.value = 'Parking'; syncNoise();`, ctx);
    assert.equal(submitButton.disabled, false);
    assert.equal(get('audioEvidence').hidden, true);
    assert.equal(get('photoEvidence').hidden, false);
    vm.runInContext(`${category}.value = 'Noise Disturbance'; syncNoise();`, ctx);
    assert.equal(submitButton.disabled, true);
    vm.runInContext(`${prefix ? 'pubRecordedFile' : 'recordedFile'} = {}; audioReady = true; ${update}();`, ctx);
    assert.equal(submitButton.disabled, false);
  });
}

test('camera capture, cancellation, upload, and permission failure', async () => {
  const source = read('frontend/js/api.js');
  new vm.Script(source);
  const fragment = source.slice(source.indexOf('function setupPhotoEvidence('), source.indexOf('const AudioRecorder ='));
  const nodes = {};
  const get = id => nodes[id] ||= { style: {}, files: [], removeAttribute() {}, play: async () => {}, videoWidth: 640, videoHeight: 480 };
  let stopped = 0, reject = false, resolveCamera;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const ctx = vm.createContext({
    document: { getElementById: get, createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: fn => fn({}) }) },
    window: { addEventListener() {} }, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    File: class { constructor(parts, name, options) { this.type = options.type; this.size = 100; } },
    navigator: { mediaDevices: { getUserMedia: async () => { if (reject) throw Error('denied'); return stream; } } }
  });
  vm.runInContext(fragment + "\nvar evidence = setupPhotoEvidence('photo');", ctx);
  await get('openCamera').onclick();
  assert.equal(get('cameraBox').hidden, false);
  get('capturePhoto').onclick();
  assert.equal(ctx.evidence.file.type, 'image/jpeg');
  assert.equal(stopped, 1);
  ctx.evidence.reset();
  assert.equal(ctx.evidence.file, null);
  const upload = { type: 'image/png', size: 200 };
  get('photo').files = [upload];
  get('photo').onchange();
  assert.equal(ctx.evidence.file, upload);
  reject = true;
  await get('openCamera').onclick();
  assert.match(get('photoError').textContent, /Camera unavailable/);
  ctx.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCamera = resolve; });
  const pending = get('openCamera').onclick();
  ctx.evidence.close();
  resolveCamera(stream);
  await pending;
  assert.equal(get('cameraBox').hidden, true);
  assert.equal(stopped, 2);
});
