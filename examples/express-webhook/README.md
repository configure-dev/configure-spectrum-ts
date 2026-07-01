# Express Webhook Example

This example composes the adapter inside Spectrum's Express webhook adapter.

Mount Spectrum's webhook middleware before global JSON parsing so Spectrum can verify the raw request body.
