def parse_multipart(body, boundary):
    return [part for part in body.split(boundary) if part]
