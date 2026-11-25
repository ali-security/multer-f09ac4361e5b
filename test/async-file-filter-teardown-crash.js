/* eslint-env mocha */

var assert = require('assert')
var stream = require('stream')
var multer = require('../')

// @see https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m

describe('async fileFilter late resume after teardown', function () {
  it('does not crash the process when a pending fileFilter resumes a parked stream after teardown', function (done) {
    var req = new stream.PassThrough()
    var filterError = new Error('file rejected')
    var resumeFilter
    var busboy
    var nextCalls = 0
    var boundary = 'TeardownBoundary'
    // Larger than the file stream's highWaterMark, so busboy parks its write
    // until the (still pending) first fileFilter lets the stream be read.
    var firstContent = new Array(256 * 1024 + 1).join('a')
    var body = [
      '--' + boundary,
      'Content-Disposition: form-data; name="first"; filename="first.txt"',
      'Content-Type: text/plain',
      '',
      firstContent,
      '--' + boundary,
      'Content-Disposition: form-data; name="second"; filename="second.txt"',
      'Content-Type: text/plain',
      '',
      'b'
      // No closing boundary: busboy will fail when its pending write completes.
    ].join('\r\n')

    // Capture the busboy instance multer pipes the request into.
    var origPipe = req.pipe
    req.pipe = function (dest) {
      busboy = dest
      return origPipe.apply(this, arguments)
    }

    var upload = multer({
      fileFilter: function (req, file, cb) {
        if (file.fieldname === 'first') {
          resumeFilter = cb
        } else {
          // Let req end and queue busboy's finalization behind the parked write.
          req.once('end', function () {
            setImmediate(function () { cb(filterError) })
          })
        }
      }
    }).any()

    req.headers = {
      'content-type': 'multipart/form-data; boundary=' + boundary,
      'content-length': Buffer.byteLength(body)
    }

    upload(req, null, function (err) {
      nextCalls++
      assert.strictEqual(err, filterError)
      assert.strictEqual(typeof resumeFilter, 'function')

      // done() queued listener removal before next(), so this runs after teardown.
      setImmediate(function () {
        var lateError = null
        var completed = false

        // Record the late busboy error without adding an error listener that
        // would mask the bug.
        var origEmit = busboy.emit
        busboy.emit = function (event, emittedErr) {
          if (event === 'error') lateError = emittedErr
          return origEmit.apply(this, arguments)
        }

        function complete () {
          if (completed) return
          completed = true
          // Some runtimes (Node 10) emit 'finish' before the late error, which
          // is then emitted on a later tick; let it surface before asserting.
          setImmediate(function () {
            assert.ok(lateError, 'expected busboy to report the truncated form')
            assert.strictEqual(lateError.message, 'Unexpected end of form')
            assert.strictEqual(nextCalls, 1)
            assert.deepStrictEqual(req.files, [])
            done()
          })
        }

        // Observe completion: 'close' where the stream is destroyed on error,
        // 'finish' where it is emitted ahead of the error (Node 10).
        busboy.once('close', complete)
        busboy.once('finish', complete)

        // Resuming the real file stream lets busboy report the truncated form.
        resumeFilter(null, true)
      })
    })

    // One write ensures both file headers are parsed while the first is parked.
    req.end(body)
  })
})
