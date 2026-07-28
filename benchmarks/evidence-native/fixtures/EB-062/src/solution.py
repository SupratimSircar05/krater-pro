def convolve(image, kernel):
    height = len(image)
    width = len(image[0])
    output = [[0 for _ in row] for row in image]
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            output[y][x] = sum(
                image[y + ky - 1][x + kx - 1] * kernel[ky][kx]
                for ky in range(3) for kx in range(3)
            )
    return output
