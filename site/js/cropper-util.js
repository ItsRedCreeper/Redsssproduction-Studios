/* CropperUtil – reusable image-crop modal backed by Cropper.js
   Usage:  CropperUtil.open(file, { aspectRatio:1, width:256, height:256 })
           .then(function(blob){ … })
           .catch(function(){ cancelled }); */
var CropperUtil = (function () {
  var _modal, _img, _cropper, _resolve, _reject, _opts;

  function _ensureModal() {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.className = 'crop-overlay';
    _modal.innerHTML =
      '<div class="crop-modal">' +
        '<div class="crop-modal-header"><h3>Crop Image</h3></div>' +
        '<div class="crop-modal-body"><img id="crop-img" alt="Preview"></div>' +
        '<div class="crop-modal-actions">' +
          '<button class="btn btn-secondary" id="crop-cancel">Cancel</button>' +
          '<button class="btn btn-primary" id="crop-confirm">Crop</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(_modal);
    _img = _modal.querySelector('#crop-img');
    _modal.querySelector('#crop-cancel').addEventListener('click', _cancel);
    _modal.querySelector('#crop-confirm').addEventListener('click', _confirm);
  }

  function open(file, opts) {
    _ensureModal();
    _opts = opts || {};
    return new Promise(function (resolve, reject) {
      _resolve = resolve;
      _reject  = reject;
      var reader = new FileReader();
      reader.onload = function (e) {
        _img.src = e.target.result;
        _modal.classList.add('active');
        if (_cropper) _cropper.destroy();
        _cropper = new Cropper(_img, {
          aspectRatio: ('aspectRatio' in _opts) ? _opts.aspectRatio : 1,
          viewMode: 1,
          dragMode: 'move',
          autoCropArea: 1,
          cropBoxResizable: true,
          background: false
        });
      };
      reader.readAsDataURL(file);
    });
  }

  function _confirm() {
    if (!_cropper) return;
    var canvasOpts = {};
    if (_opts.width)  canvasOpts.width  = _opts.width;
    if (_opts.height) canvasOpts.height = _opts.height;
    _cropper.getCroppedCanvas(canvasOpts).toBlob(function (blob) {
      _cleanup();
      _resolve(blob);
    }, 'image/png');
  }

  function _cancel() {
    _cleanup();
    if (_reject) _reject(new Error('cancelled'));
  }

  function _cleanup() {
    if (_cropper) { _cropper.destroy(); _cropper = null; }
    if (_modal) _modal.classList.remove('active');
    if (_img) _img.src = '';
  }

  return { open: open };
})();
