Throwaway self-signed certificate for tests only (`buildApp`'s HTTPS branch). Not used
anywhere outside the test suite. Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=ratatoskr-test-fixture"
```
