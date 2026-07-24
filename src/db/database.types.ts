// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate after any migration with:
//   npx supabase gen types typescript --local > src/db/database.types.ts
// (or `--project-id <ref>` / `--db-url <url>` against the target database).
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      article: {
        Row: {
          cluster_id: string | null
          created_at: string
          digest_id: string
          id: string
          original_lede: string | null
          original_title: string
          polish_summary: string | null
          polish_title: string | null
          published_at: string | null
          source_name: string
          source_url: string
        }
        Insert: {
          cluster_id?: string | null
          created_at?: string
          digest_id: string
          id?: string
          original_lede?: string | null
          original_title: string
          polish_summary?: string | null
          polish_title?: string | null
          published_at?: string | null
          source_name: string
          source_url: string
        }
        Update: {
          cluster_id?: string | null
          created_at?: string
          digest_id?: string
          id?: string
          original_lede?: string | null
          original_title?: string
          polish_summary?: string | null
          polish_title?: string | null
          published_at?: string | null
          source_name?: string
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "article_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "cluster"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "article_digest_id_fkey"
            columns: ["digest_id"]
            isOneToOne: false
            referencedRelation: "digest"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster: {
        Row: {
          coverage_count: number
          created_at: string
          digest_id: string
          id: string
          rank: number | null
          relevance_score: number | null
        }
        Insert: {
          coverage_count?: number
          created_at?: string
          digest_id: string
          id?: string
          rank?: number | null
          relevance_score?: number | null
        }
        Update: {
          coverage_count?: number
          created_at?: string
          digest_id?: string
          id?: string
          rank?: number | null
          relevance_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cluster_digest_id_fkey"
            columns: ["digest_id"]
            isOneToOne: false
            referencedRelation: "digest"
            referencedColumns: ["id"]
          },
        ]
      }
      digest: {
        Row: {
          collection_completed_at: string | null
          cost_usd: number
          created_at: string
          id: string
          last_error: string | null
          ranking_completed_at: string | null
          status: Database["public"]["Enums"]["digest_status"]
          translation_completed_at: string | null
          updated_at: string
          window_end: string
          window_start: string
        }
        Insert: {
          collection_completed_at?: string | null
          cost_usd?: number
          created_at?: string
          id?: string
          last_error?: string | null
          ranking_completed_at?: string | null
          status?: Database["public"]["Enums"]["digest_status"]
          translation_completed_at?: string | null
          updated_at?: string
          window_end: string
          window_start: string
        }
        Update: {
          collection_completed_at?: string | null
          cost_usd?: number
          created_at?: string
          id?: string
          last_error?: string | null
          ranking_completed_at?: string | null
          status?: Database["public"]["Enums"]["digest_status"]
          translation_completed_at?: string | null
          updated_at?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      digest_status:
        | "collecting"
        | "ranking"
        | "ready_for_selection"
        | "generating"
        | "ready_for_approval"
        | "approved"
        | "published"
        | "skipped"
        | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      digest_status: [
        "collecting",
        "ranking",
        "ready_for_selection",
        "generating",
        "ready_for_approval",
        "approved",
        "published",
        "skipped",
        "failed",
      ],
    },
  },
} as const

