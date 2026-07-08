import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((p) => !/^\d+$/.test(p), "Password can't be all numbers");

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  brandName: z.string().trim().max(100).optional(),
  email: z.string().trim().email("Enter a valid email"),
  password: passwordSchema,
});

export type SignUpInput = z.infer<typeof signUpSchema>;
